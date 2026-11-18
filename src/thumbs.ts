// Preview thumbnails: an on-disk store plus the two capture pipelines (claude.ai tabs Orca opened,
// and Orca chat visuals rendered by a sandboxed headless browser). Everything environment-specific
// (CLI, processes, clock, filesystem helpers) is injectable so tests never touch Orca or a browser.
import { createHash, randomBytes } from 'node:crypto'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Item, ThumbResult } from './types.ts'
import { evalArgs, extractEvalObject, extractScreenshotPath, screenshotArgs, waitFnArgs, waitLoadArgs } from './cli.ts'

export const MAX_FILES = 300
export const MAX_BYTES = 30 * 1024 * 1024
export const MAX_STORE_BYTES = 200 * 1024
export const VISUAL_TIMEOUT_MS = 15_000
export const MAX_RAW_BYTES = 700 * 1024
/** A raw's base64 data URL must stay well under the 1 MiB plugin.request answer limit. */
export const MAX_RAW_DATAURL_BYTES = 900 * 1024
export const CLEAR_WAIT_MS = 3000
const MIN_PNG_BYTES = 2048
const SETTLE_MS = 1500

export type Crop = { x: number; y: number; w: number; h: number }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code
const isEnoent = (e: unknown): boolean => errCode(e) === 'ENOENT'
const snippet = (v: unknown, n = 160): string => {
  let t: string
  try {
    t = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  } catch {
    t = String(v)
  }
  return t.length > n ? `${t.slice(0, n)}...` : t
}

export const hashKey = (key: string): string => createHash('sha1').update(key).digest('hex')
export const sanitizeRev = (rev: string): string => rev.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '0'

/** claude: the last publish's version id, else the update time. */
export function claudeRev(item: Item): string {
  const v = item.versions[item.versions.length - 1]?.version
  return sanitizeRev(v ? v : String(item.updatedAt))
}

/** visual: `<mtimeMs>-<size>` of the file; null when it cannot be read. */
export async function visualRev(item: Item, stat: (p: string) => Promise<{ mtimeMs: number; size: number }> = fsp.stat): Promise<string | null> {
  if (!item.filePath) return null
  try {
    const s = await stat(item.filePath)
    return sanitizeRev(`${Math.round(s.mtimeMs)}-${s.size}`)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- store

type Entry = { name: string; hash: string; rev: string; raw: boolean; ext: 'jpg' | 'png'; size: number; mtime: number }

const FILE_RE = /^([0-9a-f]{40})-([A-Za-z0-9_-]+?)(\.raw)?\.(jpg|png)$/

export type ThumbStore = {
  has(key: string, rev: string): Promise<boolean>
  /** Newest stored rev (final or raw) of the key, any version. */
  newest(key: string): Promise<string | null>
  readFinal(key: string, rev: string): Promise<Buffer | null>
  readRaw(key: string, rev: string): Promise<{ data: Buffer; ext: 'jpg' | 'png'; crop: Crop | null } | null>
  hasRaw(key: string, rev: string): Promise<boolean>
  putFinal(key: string, rev: string, data: Buffer): Promise<void>
  putRaw(key: string, rev: string, data: Buffer, ext: 'jpg' | 'png', crop: Crop | null): Promise<void>
  clearAll(): Promise<void>
  dir: string
}

export function createThumbStore(dir: string, log: (m: string) => void = () => {}): ThumbStore {
  let files: Map<string, Entry> | null = null

  async function ensure(): Promise<Map<string, Entry>> {
    if (files) return files
    const m = new Map<string, Entry>()
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch (e) {
      if (!isEnoent(e)) log(`thumbs: cannot read ${dir}: ${errMsg(e)}`)
    }
    for (const name of names) {
      const full = path.join(dir, name)
      const mm = FILE_RE.exec(name)
      if (mm) {
        try {
          const st = await fsp.stat(full)
          m.set(name, { name, hash: mm[1], rev: mm[2], raw: Boolean(mm[3]), ext: mm[4] as 'jpg' | 'png', size: st.size, mtime: st.mtimeMs })
        } catch {
          // vanished
        }
      } else if (/^(profile-|cap-)|\.tmp-/.test(name)) {
        await fsp.rm(full, { recursive: true, force: true }).catch((e) => {
          if (!isEnoent(e)) log(`thumbs: cannot remove leftover ${name}: ${errMsg(e)}`) // leftovers of a crashed run
        })
      }
    }
    files = m
    return m
  }

  const nameOf = (key: string, rev: string, raw: boolean, ext: string): string => `${hashKey(key)}-${sanitizeRev(rev)}${raw ? '.raw' : ''}.${ext}`

  async function atomicWrite(name: string, data: Buffer | string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `${name}.tmp-${randomBytes(4).toString('hex')}`)
    try {
      await fsp.writeFile(tmp, data)
      await fsp.rename(tmp, path.join(dir, name))
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  async function remove(m: Map<string, Entry>, e: Entry): Promise<void> {
    try {
      await fsp.rm(path.join(dir, e.name), { force: true })
    } catch (err) {
      // Keep the entry: the file is still on disk and still counts against the cap.
      if (!isEnoent(err)) {
        log(`thumbs: cannot remove ${e.name}: ${errMsg(err)}`)
        return
      }
    }
    m.delete(e.name)
    if (e.raw) {
      await fsp.rm(path.join(dir, e.name.replace(/\.(jpg|png)$/, '.json')), { force: true }).catch((err) => {
        if (!isEnoent(err)) log(`thumbs: cannot remove crop of ${e.name}: ${errMsg(err)}`)
      })
    }
  }

  async function register(m: Map<string, Entry>, key: string, rev: string, raw: boolean, ext: 'jpg' | 'png', size: number): Promise<void> {
    const r = sanitizeRev(rev)
    const hash = hashKey(key)
    const name = nameOf(key, r, raw, ext)
    m.set(name, { name, hash, rev: r, raw, ext, size, mtime: Date.now() })
    // Older revs of the same key go away; a raw of the same rev goes once the final exists.
    for (const e of [...m.values()]) {
      if (e.hash !== hash || e.name === name) continue
      if (e.rev !== r || (!raw && e.raw)) await remove(m, e)
    }
    // LRU cap by mtime, never the file just written.
    const all = [...m.values()].sort((a, b) => a.mtime - b.mtime)
    let bytes = all.reduce((n, e) => n + e.size, 0)
    let count = all.length
    for (const e of all) {
      if (count <= MAX_FILES && bytes <= MAX_BYTES) break
      if (e.name === name) continue
      await remove(m, e)
      count--
      bytes -= e.size
    }
  }

  const find = (m: Map<string, Entry>, key: string, rev: string, raw: boolean): Entry | undefined => {
    const hash = hashKey(key)
    const r = sanitizeRev(rev)
    return [...m.values()].find((e) => e.hash === hash && e.rev === r && e.raw === raw)
  }

  async function touch(e: Entry): Promise<void> {
    e.mtime = Date.now()
    const t = new Date(e.mtime)
    await fsp.utimes(path.join(dir, e.name), t, t).catch(() => {})
  }

  async function read(e: Entry | undefined): Promise<Buffer | null> {
    if (!e) return null
    try {
      const b = await fsp.readFile(path.join(dir, e.name))
      void touch(e)
      return b
    } catch (err) {
      if (!isEnoent(err)) log(`thumbs: cannot read ${e.name}: ${errMsg(err)}`)
      files?.delete(e.name)
      return null
    }
  }

  return {
    dir,
    async has(key, rev) {
      const m = await ensure()
      return Boolean(find(m, key, rev, false) ?? find(m, key, rev, true))
    },
    async hasRaw(key, rev) {
      return Boolean(find(await ensure(), key, rev, true))
    },
    async newest(key) {
      const hash = hashKey(key)
      const mine = [...(await ensure()).values()].filter((e) => e.hash === hash).sort((a, b) => b.mtime - a.mtime)
      return mine[0]?.rev ?? null
    },
    async readFinal(key, rev) {
      return read(find(await ensure(), key, rev, false))
    },
    async readRaw(key, rev) {
      const e = find(await ensure(), key, rev, true)
      const data = await read(e)
      if (!e || !data) return null
      let crop: Crop | null = null
      try {
        const j: unknown = JSON.parse(await fsp.readFile(path.join(dir, e.name.replace(/\.(jpg|png)$/, '.json')), 'utf8'))
        const c = (j as { crop?: Crop | null } | null)?.crop
        if (c && [c.x, c.y, c.w, c.h].every((n) => Number.isFinite(n))) crop = c
      } catch (err) {
        // no crop: the panel uses the whole capture
        if (!isEnoent(err)) log(`thumbs: cannot read crop of ${e.name}: ${errMsg(err)}`)
      }
      return { data, ext: e.ext, crop }
    },
    async putFinal(key, rev, data) {
      const m = await ensure()
      await atomicWrite(nameOf(key, rev, false, 'jpg'), data)
      await register(m, key, rev, false, 'jpg', data.length)
    },
    async putRaw(key, rev, data, ext, crop) {
      const m = await ensure()
      const name = nameOf(key, rev, true, ext)
      const jsonName = name.replace(/\.(jpg|png)$/, '.json')
      await atomicWrite(name, data)
      try {
        await atomicWrite(jsonName, JSON.stringify({ crop }))
      } catch (e) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {})
        throw e
      }
      await register(m, key, rev, true, ext, data.length)
    },
    async clearAll() {
      files = null // rescan whatever is left if the wipe fails half way
      try {
        await fsp.rm(dir, { recursive: true, force: true })
      } catch (e) {
        log(`thumbs: clear failed: ${errMsg(e)}`)
        throw e
      }
      files = new Map()
    }
  }
}

// ---------------------------------------------------------------- helpers

/** Width/height of a JPEG from its SOF marker, or null. */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function normalizeCrop(r: unknown, size: { w: number; h: number } | null): Crop | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const nums = [o.x, o.y, o.width, o.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  let x = Math.max(0, Math.round(o.x as number))
  let y = Math.max(0, Math.round(o.y as number))
  let w = Math.round(o.width as number)
  let h = Math.round(o.height as number)
  if (size) {
    w = Math.min(w, size.w - x)
    h = Math.min(h, size.h - y)
  }
  x = Math.min(x, 1e5)
  y = Math.min(y, 1e5)
  return w >= 16 && h >= 16 ? { x, y, w, h } : null
}

export const isOrcaScreenshot = (p: string): boolean => {
  const parts = p.split(/[\\/]/)
  return !parts.includes('..') && parts.slice(0, -1).includes('orca-browser-screenshots')
}

export type CaptureIo = {
  readFile(p: string): Promise<Buffer>
  unlink(p: string): Promise<void>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const defaultIo: CaptureIo = {
  readFile: (p) => fsp.readFile(p),
  unlink: (p) => fsp.unlink(p),
  sleep: (ms, signal) =>
    new Promise((res) => {
      const onAbort = (): void => {
        clearTimeout(t)
        res()
      }
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        res()
      }, ms)
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

// ---------------------------------------------------------------- claude.ai capture

export type CliCall = (args: string[], timeoutMs: number) => Promise<unknown>

const IFRAME_READY = "document.querySelector('iframe#frame-content.ready')"
const PROBE =
  "JSON.stringify({path: location.pathname, r: (function(f){return f && f.getBoundingClientRect().toJSON()})(document.querySelector('iframe#frame-content'))})"
const PATH_ONLY = 'JSON.stringify({path: location.pathname})'

export type CaptureOutcome = { stored: boolean; reason?: string; aborted?: boolean }

class AbortedError extends Error {}

/**
 * Captures the artifact iframe of an already-open claude.ai tab. Never closes or navigates the tab.
 * Every failure is logged as `thumb <key>: <step>: <message>` with the step that failed.
 */
export async function captureClaude(
  d: { runCli: CliCall; io: CaptureIo; store: ThumbStore; signal?: AbortSignal; log: (m: string) => void },
  pageId: string,
  item: Item,
  rev: string
): Promise<CaptureOutcome> {
  const slug = item.key.replace(/^claude:/, '')
  const expected = `/artifact/${slug}`
  const pathOk = (p: unknown): boolean => typeof p === 'string' && p.endsWith(expected)
  let step = 'wait-load'
  const fail = (reason: string): CaptureOutcome => {
    d.log(`thumb ${item.key}: ${step}: ${reason}`)
    return { stored: false, reason: `${step}: ${reason}` }
  }
  const checkAbort = (): void => {
    if (d.signal?.aborted) throw new AbortedError()
  }
  /** A failure reason for an eval result that is not the expected artifact tab, else null. */
  const probeFail = (obj: Record<string, unknown> | null, raw: unknown): string | null => {
    if (!obj) return `unparseable eval output ${snippet(raw)}`
    if (!pathOk(obj.path)) return `tab is on ${typeof obj.path === 'string' ? obj.path : snippet(obj.path)}, not ${expected}`
    return null
  }
  let shot: string | null = null
  try {
    checkAbort()
    await d.runCli(waitLoadArgs(pageId, 15_000), 20_000)
    checkAbort()
    step = 'wait-frame'
    try {
      await d.runCli(waitFnArgs(pageId, IFRAME_READY, 10_000), 15_000)
    } catch (e) {
      return fail(`artifact frame never became ready (${errMsg(e)})`)
    }
    checkAbort()
    await d.io.sleep(SETTLE_MS, d.signal)
    checkAbort()
    step = 'probe'
    const probeOut = await d.runCli(evalArgs(pageId, PROBE), 10_000)
    checkAbort()
    const before = extractEvalObject(probeOut)
    const pf = probeFail(before, probeOut)
    if (pf) return fail(pf)
    if (!before?.r) return fail('artifact frame not found')
    step = 'screenshot'
    const out = await d.runCli(screenshotArgs(pageId), 20_000)
    shot = extractScreenshotPath(out) // before the abort check: the temp file must still be removed
    checkAbort()
    if (!shot) return fail(`returned no file (output: ${snippet(out)})`)
    step = 'recheck'
    const recheckOut = await d.runCli(evalArgs(pageId, PATH_ONLY), 10_000)
    checkAbort()
    const rf = probeFail(extractEvalObject(recheckOut), recheckOut)
    if (rf) return fail(rf)
    step = 'read'
    const data = await d.io.readFile(shot)
    checkAbort()
    if (data.length > MAX_RAW_BYTES) return fail(`capture too large for the panel (${Math.round(data.length / 1024)} KB)`)
    const crop = normalizeCrop(before.r, jpegSize(data))
    if (!crop) return fail('artifact frame has no usable size')
    step = 'store'
    checkAbort()
    await d.store.putRaw(item.key, rev, data, 'jpg', crop)
    return { stored: true }
  } catch (e) {
    if (e instanceof AbortedError) {
      d.log(`thumb ${item.key}: aborted`)
      return { stored: false, reason: 'aborted', aborted: true }
    }
    return fail(errMsg(e))
  } finally {
    if (shot && isOrcaScreenshot(shot)) await d.io.unlink(shot).catch(() => {})
  }
}

// ---------------------------------------------------------------- visuals capture

export const ALLOWED_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com']

export const FORBIDDEN_FLAGS = ['--no-sandbox', '--allow-file-access-from-files', '--disable-web-security', '--disable-site-isolation-trials']

export function headlessArgs(o: { profileDir: string; outFile: string; url: string }): string[] {
  if (!/^file:\/\/\//.test(o.url) || /[\s\u0000-\u001f]/.test(o.url)) throw new Error('Refusing to render a URL that is not file:///...')
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-proxy-server',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--force-webrtc-ip-handling-policy',
    `--user-data-dir=${o.profileDir}`,
    '--window-size=1024,640',
    '--force-device-scale-factor=0.5',
    '--virtual-time-budget=3000',
    `--host-resolver-rules=MAP * ~NOTFOUND, ${ALLOWED_HOSTS.map((h) => `EXCLUDE ${h}`).join(', ')}`,
    `--screenshot=${o.outFile}`,
    o.url
  ]
}

export type ChildLike = {
  pid?: number
  kill(signal?: string): unknown
  once(event: 'exit' | 'error', cb: (...args: unknown[]) => void): unknown
}

export type ProcDeps = {
  platform: string
  spawn(file: string, args: string[]): ChildLike
  /** Kills the process tree (taskkill /T /F, or kill -9 of the group). */
  killTree(pid: number): Promise<void>
  stat(p: string): Promise<{ size: number; mtimeMs: number }>
  rm(p: string): Promise<void>
  now(): number
}

export function defaultProcDeps(log: (m: string) => void = () => {}): ProcDeps {
  const platform = process.platform
  return {
    platform,
    spawn: (file, args) =>
      nodeSpawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore', detached: platform !== 'win32' }) as unknown as ChildLike,
    killTree: (pid) =>
      new Promise((res) => {
        if (platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false }, (err) => {
            if (err) log(`thumbs: taskkill ${pid} failed: ${errMsg(err)}`)
            res()
          })
        } else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch (e) {
            if (errCode(e) !== 'ESRCH') log(`thumbs: kill -${pid} failed: ${errMsg(e)}`)
          }
          res()
        }
      }),
    stat: (p) => fsp.stat(p),
    rm: (p) => fsp.rm(p, { recursive: true, force: true }),
    now: () => Date.now()
  }
}

/** Runs the headless browser; resolves ok or a reason. Always cleans the profile dir and its abort listener. */
export async function runHeadless(
  p: ProcDeps,
  io: Pick<CaptureIo, 'sleep'>,
  browser: string,
  o: { profileDir: string; outFile: string; url: string },
  opts: { timeoutMs?: number; signal?: AbortSignal; log?: (m: string) => void } = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timeoutMs = opts.timeoutMs ?? VISUAL_TIMEOUT_MS
  const log = opts.log ?? (() => {})
  const started = p.now()
  let child: ChildLike | undefined
  let reason: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    child = p.spawn(browser, headlessArgs(o))
    const c = child
    let spawnErr = ''
    let exitInfo = ''
    const exited = new Promise<'exit' | 'error'>((res) => {
      c.once('exit', (code, signal) => {
        exitInfo = `exit code ${code ?? '-'}${signal ? `, signal ${String(signal)}` : ''}`
        res('exit')
      })
      c.once('error', (e) => {
        const code = errCode(e)
        spawnErr = `${code ? `${code} ` : ''}${errMsg(e)}`.trim()
        res('error')
      })
    })
    const timeout = new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), timeoutMs)))
    const aborted = new Promise<'abort'>((res) => {
      if (opts.signal?.aborted) return res('abort')
      onAbort = () => res('abort')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
    const outcome = await Promise.race([exited, timeout, aborted])
    if (timer) clearTimeout(timer)
    if (outcome !== 'exit') {
      if (child.pid) await p.killTree(child.pid)
      else child.kill('SIGKILL')
      reason = outcome === 'timeout' ? 'the browser timed out' : outcome === 'error' ? `the browser could not start (${spawnErr})` : 'aborted'
    }
    if (!reason) {
      try {
        const st = await p.stat(o.outFile)
        if (st.size <= MIN_PNG_BYTES) reason = `the capture is empty (${st.size} bytes; ${exitInfo})`
        else if (st.mtimeMs < started - 1000) reason = `the capture is stale (${exitInfo})`
      } catch (e) {
        reason = `the browser produced no capture (${exitInfo}; ${errMsg(e)})`
      }
    }
  } catch (e) {
    reason = errMsg(e)
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    try {
      await p.rm(o.profileDir)
    } catch {
      await io.sleep(500)
      await p.rm(o.profileDir).catch((e) => log(`thumbs: cannot remove profile ${o.profileDir}: ${errMsg(e)}`))
    }
  }
  return reason ? { ok: false, reason } : { ok: true }
}

// ---------------------------------------------------------------- manager

export type ThumbManagerOpts = {
  dir: string
  log: (m: string) => void
  enabled(): boolean
  /** Resolves the headless browser (settings + well-known paths). */
  browser(): { path: string | null; reason?: string }
  runCli: CliCall
  /** Called when the panel should re-ask (a thumbnail was stored, or a visual task ended without one). Must be a no-op once the worker is stopped. */
  onStored(): void
  io?: CaptureIo
  proc?: ProcDeps
  stat?: (p: string) => Promise<{ mtimeMs: number; size: number }>
  /** Max time `clearAll` waits for running captures (default 3 s). */
  clearWaitMs?: number
}

export type ThumbManager = {
  /** Fills `Item.thumb` for items that have a stored preview. Mutates and returns the same array. */
  fill(items: Item[]): Promise<Item[]>
  get(item: Item): Promise<ThumbResult>
  store(item: Item, rev: string, dataUrl: string): Promise<{ ok: boolean; reason?: string }>
  /** Called right after a claude tab was opened: captures it in the background if no thumb exists for the current rev. */
  captureOpened(pageId: string, item: Item): void
  clearAll(): Promise<void>
  abortAll(): void
  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void>
  readonly store_: ThumbStore
}

const dataUrl = (mime: string, b: Buffer): string => `data:${mime};base64,${b.toString('base64')}`

export function createThumbManager(o: ThumbManagerOpts): ThumbManager {
  const io = o.io ?? defaultIo
  const proc = o.proc ?? defaultProcDeps(o.log)
  const statFn = o.stat ?? ((p: string) => fsp.stat(p))
  const store = createThumbStore(o.dir, o.log)
  let chain: Promise<unknown> = Promise.resolve()
  let abort = new AbortController()
  const inflight = new Set<string>()
  /** key -> rev whose capture failed this session; never retried for that rev (aborted captures are not recorded). */
  const failed = new Map<string, { rev: string; reason: string }>()
  /** claude keys the user opened this session (so a missing preview can say why). */
  const opened = new Set<string>()
  const noBrowserLogged = new Set<string>()
  let probedLogged = false

  const revOf = (item: Item): Promise<string | null> =>
    item.kind === 'claude' ? Promise.resolve(claudeRev(item)) : visualRev(item, statFn)

  /** The headless browser, logging each distinct "not found" reason once. */
  function browser(): { path: string | null; reason?: string } {
    const b = o.browser()
    if (!b.path) {
      const reason = b.reason ?? 'No browser available'
      if (!noBrowserLogged.has(reason)) {
        noBrowserLogged.add(reason)
        o.log(`thumbs: no browser for visual previews: ${reason}`)
      }
      return { path: null, reason }
    }
    return b
  }

  /**
   * Serial queue, one task per key at a time. A visual task that ends without storing (failed, skipped,
   * aborted) still notifies, so the panel re-asks and gets `none` or a fresh capture.
   */
  function enqueue(key: string, task: (signal: AbortSignal) => Promise<boolean>, notifyIfNotStored = false): void {
    if (inflight.has(key)) return
    inflight.add(key)
    const signal = abort.signal
    const run = async (): Promise<void> => {
      let stored = false
      try {
        if (signal.aborted || !o.enabled()) {
          o.log(`thumb ${key}: skipped (previews ${!o.enabled() ? 'disabled' : 'aborted'})`)
        } else {
          stored = await task(signal)
        }
      } catch (e) {
        o.log(`thumb ${key}: ${errMsg(e)}`)
      } finally {
        inflight.delete(key)
      }
      if (!stored && notifyIfNotStored) o.onStored()
    }
    chain = chain.then(run, run)
  }

  async function captureVisual(item: Item, rev: string, signal: AbortSignal): Promise<boolean> {
    const b = browser()
    if (!b.path) {
      failed.set(item.key, { rev, reason: b.reason ?? 'No browser available' })
      return false
    }
    if (!probedLogged) {
      probedLogged = true
      o.log('thumbs: raw mode (the worker cannot downscale images itself; the panel does)')
    }
    const id = randomBytes(6).toString('hex')
    const outFile = path.join(o.dir, `cap-${id}.png`)
    const profileDir = path.join(o.dir, `profile-${id}`)
    const fail = (reason: string): false => {
      if (signal.aborted || reason === 'aborted') {
        o.log(`thumb ${item.key}: aborted`)
        return false
      }
      failed.set(item.key, { rev, reason })
      o.log(`thumb ${item.key}: ${reason} (browser ${b.path})`)
      return false
    }
    try {
      await fsp.mkdir(o.dir, { recursive: true })
      const r = await runHeadless(proc, io, b.path, { profileDir, outFile, url: item.url }, { signal, log: o.log })
      if (!r.ok) return fail(r.reason)
      if (signal.aborted) return fail('aborted')
      const data = await io.readFile(outFile)
      if (data.length > MAX_RAW_BYTES) return fail(`capture too large for the panel (${Math.round(data.length / 1024)} KB)`)
      if (signal.aborted) return fail('aborted')
      await store.putRaw(item.key, rev, data, 'png', null)
      if (signal.aborted) return false // stored, but the worker is shutting down: no post
      failed.delete(item.key)
      o.onStored()
      return true
    } catch (e) {
      return fail(errMsg(e))
    } finally {
      await io.unlink(outFile).catch(() => {})
    }
  }

  return {
    store_: store,
    async fill(items) {
      if (!o.enabled()) return items
      for (const item of items) {
        try {
          const newest = await store.newest(item.key)
          if (!newest) continue
          const rev = await revOf(item)
          // The current rev when stored, else the newest older one (stale until re-captured).
          item.thumb = rev && (await store.has(item.key, rev)) ? rev : newest
        } catch (e) {
          o.log(`thumb fill ${item.key}: ${errMsg(e)}`)
        }
      }
      return items
    },
    async get(item) {
      if (!o.enabled()) return { kind: 'none', reason: 'Previews are turned off in the plugin settings' }
      const rev = await revOf(item)
      if (!rev) return { kind: 'none', reason: 'The file cannot be read' }
      const serve = async (r: string): Promise<ThumbResult | null> => {
        const fin = await store.readFinal(item.key, r)
        if (fin) {
          if (Math.ceil((fin.length * 4) / 3) > MAX_RAW_DATAURL_BYTES) return { kind: 'none', reason: 'The stored preview is too large to send to the panel' }
          return { kind: 'ready', rev: r, dataUrl: dataUrl('image/jpeg', fin) }
        }
        const raw = await store.readRaw(item.key, r)
        if (raw) {
          if (Math.ceil((raw.data.length * 4) / 3) > MAX_RAW_DATAURL_BYTES) {
            return { kind: 'none', reason: `The capture is too large for the panel (${Math.round(raw.data.length / 1024)} KB)` }
          }
          return { kind: 'raw', rev: r, dataUrl: dataUrl(raw.ext === 'png' ? 'image/png' : 'image/jpeg', raw.data), crop: raw.crop }
        }
        return null
      }
      const hit = await serve(rev)
      if (hit) return hit
      const newest = await store.newest(item.key)
      const stale = newest && newest !== rev ? await serve(newest) : null
      const f = failed.get(item.key)
      const failure = f && f.rev === rev ? f : undefined
      if (item.kind === 'claude') {
        if (stale) return stale
        if (failure && opened.has(item.key)) return { kind: 'none', reason: failure.reason }
        return { kind: 'none', reason: 'Open the artifact once to get a preview' }
      }
      // Visual: show the stale image meanwhile, and (re)capture the current rev unless that already failed.
      if (!failure) {
        const b = browser()
        if (b.path) enqueue(item.key, (signal) => captureVisual(item, rev, signal), true)
        else if (!stale) return { kind: 'none', reason: b.reason ?? 'No browser available' }
      }
      if (stale) return stale
      return failure ? { kind: 'none', reason: failure.reason } : { kind: 'capturing' }
    },
    async store(item, rev, url) {
      if (!o.enabled()) return { ok: false, reason: 'Previews are turned off' }
      if (typeof rev !== 'string' || !rev) return { ok: false, reason: 'rev is required' }
      if (!(await store.hasRaw(item.key, rev))) return { ok: false, reason: 'No pending capture for that rev' }
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof url === 'string' ? url : '')
      if (!m || m[1].length > Math.ceil((MAX_STORE_BYTES * 4) / 3) + 4) return { ok: false, reason: 'Expected a JPEG data URL of at most 200 KB' }
      const data = Buffer.from(m[1], 'base64')
      if (data.length > MAX_STORE_BYTES) return { ok: false, reason: 'Thumbnail is larger than 200 KB' }
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return { ok: false, reason: 'Not a JPEG image' }
      await store.putFinal(item.key, rev, data)
      return { ok: true }
    },
    captureOpened(pageId, item) {
      if (item.kind !== 'claude' || !o.enabled()) return
      const rev = claudeRev(item)
      opened.add(item.key)
      enqueue(item.key, async (signal) => {
        if (await store.has(item.key, rev)) return false
        const r = await captureClaude({ runCli: o.runCli, io, store, signal, log: o.log }, pageId, item, rev)
        if (signal.aborted) return false // never post (or remember a failure) after an abort
        if (r.stored) {
          failed.delete(item.key)
          o.onStored()
          return true
        }
        failed.set(item.key, { rev, reason: r.reason ?? 'capture failed' })
        return false
      })
    },
    async clearAll() {
      abort.abort()
      abort = new AbortController()
      const limit = o.clearWaitMs ?? CLEAR_WAIT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const waited = await Promise.race([
        chain.then(() => 'idle' as const, () => 'idle' as const),
        new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), limit)))
      ])
      if (timer) clearTimeout(timer)
      if (waited === 'timeout') o.log(`thumbs: clearAll did not wait for running captures (> ${limit} ms)`)
      failed.clear()
      opened.clear()
      await store.clearAll()
    },
    abortAll() {
      abort.abort()
      abort = new AbortController()
    },
    idle: async () => {
      await chain
    }
  }
}
