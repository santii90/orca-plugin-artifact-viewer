import { test, assert } from 'orca/testing'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALLOWED_HOSTS,
  FORBIDDEN_FLAGS,
  MAX_BYTES,
  MAX_FILES,
  captureClaude,
  claudeRev,
  createThumbManager,
  createThumbStore,
  defaultIo,
  hashKey,
  headlessArgs,
  isOrcaScreenshot,
  runHeadless,
  visualRev,
  type CaptureIo,
  type ChildLike,
  type ProcDeps
} from './thumbs.ts'
import { CliError } from './cli.ts'
import { findBrowser, thumbsDir, type PathsEnv } from './paths.ts'
import type { Item } from './types.ts'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-test-'))
const jpeg = (n = 600): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)])
/** Minimal JPEG with a SOF0 header of the given size. */
const sofJpeg = (w: number, h: number): Buffer => {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(17, 0)
  sof[2] = 8
  sof.writeUInt16BE(h, 3)
  sof.writeUInt16BE(w, 5)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.alloc(40)])
}
const claudeItem = (slug = 'abc', over: Partial<Item> = {}): Item => ({
  key: `claude:${slug}`, kind: 'claude', url: `https://claude.ai/artifact/${slug}`, title: slug, firstSeenAt: 1, updatedAt: 100,
  publishCount: 1, versions: [{ at: 1, sessionId: 's', action: 'create', version: 'v1' }], sessionIds: [], lastCwd: '/x', ...over
})
const noSleep: CaptureIo['sleep'] = async () => {}

test('rev: claude uses the last version id, falls back to updatedAt; sanitized', () => {
  assert.equal(claudeRev(claudeItem('a')), 'v1')
  assert.equal(claudeRev(claudeItem('a', { versions: [] })), '100')
  assert.equal(claudeRev(claudeItem('a', { versions: [{ at: 1, sessionId: 's', action: 'create', version: '../a b.raw' }] })), '___a_b_raw')
})

test('rev: visual is mtime-size of the file, null when unreadable', async () => {
  const v: Item = { ...claudeItem('x'), key: 'visual:c/x.html', kind: 'visual', filePath: 'C:/x.html' }
  assert.equal(await visualRev(v, async () => ({ mtimeMs: 1234.6, size: 99 })), '1235-99')
  assert.equal(await visualRev(v, async () => { throw new Error('ENOENT') }), null)
  assert.equal(await visualRev({ ...v, filePath: undefined }), null)
})

test('store: atomic write leaves no temp files; newer rev deletes older ones', async () => {
  const dir = tmp()
  const s = createThumbStore(dir)
  await s.putFinal('claude:a', 'v1', jpeg())
  await s.putFinal('claude:a', 'v2', jpeg(700))
  assert.deepEqual(fs.readdirSync(dir), [`${hashKey('claude:a')}-v2.jpg`])
  assert.equal(await s.has('claude:a', 'v1'), false)
  assert.equal((await s.readFinal('claude:a', 'v2'))?.length, 704)
  assert.equal(await s.newest('claude:a'), 'v2')
})

test('store: a failed write leaves no partial file and does not register', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'blocker'), 'x')
  const s = createThumbStore(path.join(dir, 'blocker', 'sub')) // mkdir fails: the parent is a file
  await assert.rejects(s.putFinal('claude:a', 'v1', jpeg()))
  assert.equal(await s.has('claude:a', 'v1'), false)
})

test('store: raw + crop round-trip; final of the same rev replaces the raw', async () => {
  const dir = tmp()
  const s = createThumbStore(dir)
  await s.putRaw('claude:a', 'v1', jpeg(), 'jpg', { x: 0, y: 45, w: 800, h: 500 })
  assert.equal(await s.hasRaw('claude:a', 'v1'), true)
  assert.deepEqual((await s.readRaw('claude:a', 'v1'))?.crop, { x: 0, y: 45, w: 800, h: 500 })
  await s.putFinal('claude:a', 'v1', jpeg(300))
  assert.equal(await s.hasRaw('claude:a', 'v1'), false)
  assert.deepEqual(fs.readdirSync(dir), [`${hashKey('claude:a')}-v1.jpg`])
})

test('store: LRU cap evicts the oldest files but never the one just written', async () => {
  const dir = tmp()
  const s = createThumbStore(dir)
  for (let i = 0; i < MAX_FILES + 5; i++) await s.putFinal(`claude:k${i}`, 'v1', jpeg(50))
  assert.equal(fs.readdirSync(dir).length, MAX_FILES)
  assert.equal(await s.has(`claude:k${MAX_FILES + 4}`, 'v1'), true)
  assert.equal(await s.has('claude:k0', 'v1'), false)
})

test('store: index is rebuilt from disk; leftovers of crashed runs are removed; clearAll wipes', async () => {
  const dir = tmp()
  const a = createThumbStore(dir)
  await a.putFinal('claude:a', 'v1', jpeg())
  fs.mkdirSync(path.join(dir, 'profile-dead'))
  fs.writeFileSync(path.join(dir, 'cap-1.png'), 'x')
  fs.writeFileSync(path.join(dir, `${hashKey('claude:a')}-v1.jpg.tmp-ab`), 'x')
  const b = createThumbStore(dir)
  assert.equal(await b.has('claude:a', 'v1'), true)
  assert.deepEqual(fs.readdirSync(dir), [`${hashKey('claude:a')}-v1.jpg`])
  await b.clearAll()
  assert.equal(fs.existsSync(dir), false)
  assert.equal(await b.has('claude:a', 'v1'), false)
})

test('isOrcaScreenshot only accepts files directly inside an orca-browser-screenshots folder', () => {
  assert.equal(isOrcaScreenshot('C:\\Users\\u\\AppData\\Local\\Temp\\orca-browser-screenshots\\a-screenshot.jpg'), true)
  assert.equal(isOrcaScreenshot('/tmp/orca-browser-screenshots/a.jpg'), true)
  assert.equal(isOrcaScreenshot('C:\\Users\\u\\Documents\\a.jpg'), false)
  assert.equal(isOrcaScreenshot('/tmp/orca-browser-screenshots/../../etc/a.jpg'), false)
  assert.equal(isOrcaScreenshot('/tmp/orca-browser-screenshots'), false)
})

// ---- claude capture pipeline

const SHOT = 'C:\\Temp\\orca-browser-screenshots\\u-screenshot.jpg'

function fakeCli(over: { path?: string | ((n: number) => string); rect?: unknown; shot?: unknown; failOn?: string } = {}) {
  const calls: string[][] = []
  let probes = 0
  const run = async (args: string[]): Promise<unknown> => {
    calls.push(args)
    const kind = args[0] === 'wait' ? (args.includes('--fn') ? 'waitfn' : 'waitload') : args[0]
    if (over.failOn === kind) throw new CliError('cli_timeout', `${kind} timed out`)
    if (kind === 'eval') {
      probes++
      const p = typeof over.path === 'function' ? over.path(probes) : (over.path ?? '/artifact/abc')
      const withRect = args[4].includes('getBoundingClientRect')
      const r = over.rect === undefined ? { x: 0, y: 45, width: 800, height: 600 } : over.rect
      return { result: JSON.stringify(withRect ? { path: p, r } : { path: p }) } // real shape: the envelope's result is `{ result: "<JSON string>" }`
    }
    if (kind === 'screenshot') return over.shot === undefined ? { path: SHOT } : over.shot
    return {}
  }
  return { run, calls }
}

function fakeIo(data: Buffer = sofJpeg(1000, 700)) {
  const unlinked: string[] = []
  const io: CaptureIo = {
    readFile: async () => data,
    unlink: async (p) => { unlinked.push(p) },
    sleep: noSleep
  }
  return { io, unlinked }
}

async function runClaude(over: Parameters<typeof fakeCli>[0] = {}, io = fakeIo()) {
  const store = createThumbStore(tmp())
  const cli = fakeCli(over)
  const logs: string[] = []
  const r = await captureClaude({ runCli: cli.run, io: io.io, store, log: (m) => logs.push(m) }, 'page-1', claudeItem('abc'), 'v1')
  return { r, store, cli, io, logs }
}

test('claude capture: happy path stores a raw capture with the iframe crop and unlinks the temp screenshot', async () => {
  const { r, store, cli, io } = await runClaude()
  assert.equal(r.stored, true)
  assert.deepEqual((await store.readRaw('claude:abc', 'v1'))?.crop, { x: 0, y: 45, w: 800, h: 600 })
  assert.deepEqual(io.unlinked, [SHOT])
  assert.deepEqual(cli.calls.map((c) => c[0]), ['wait', 'wait', 'eval', 'screenshot', 'eval'])
  assert.ok(cli.calls[0].includes('--load'))
  assert.ok(cli.calls[1].includes('--fn') && cli.calls[1].join(' ').includes('iframe#frame-content.ready'))
  assert.ok(cli.calls.every((c) => c[c.indexOf('--page') + 1] === 'page-1'))
})

test('claude capture: the crop is clamped to the screenshot size', async () => {
  const { store } = await runClaude({ rect: { x: 0, y: 45, width: 5000, height: 5000 } }, fakeIo(sofJpeg(1000, 700)))
  assert.deepEqual((await store.readRaw('claude:abc', 'v1'))?.crop, { x: 0, y: 45, w: 1000, h: 655 })
})

test('claude capture: path changed before or after the screenshot stores nothing', async () => {
  const before = await runClaude({ path: '/chats/other' })
  assert.equal(before.r.stored, false)
  assert.equal(before.cli.calls.some((c) => c[0] === 'screenshot'), false)
  const after = await runClaude({ path: (n) => (n === 1 ? '/artifact/abc' : '/chats/other') })
  assert.equal(after.r.stored, false)
  assert.equal(await after.store.has('claude:abc', 'v1'), false)
  assert.deepEqual(after.io.unlinked, [SHOT]) // the temp file is still cleaned
})

test('claude capture: a code URL path is accepted, a different slug is not', async () => {
  assert.equal((await runClaude({ path: '/code/artifact/abc' })).r.stored, true)
  assert.equal((await runClaude({ path: '/artifact/abcd' })).r.stored, false)
})

test('claude capture: missing iframe or frame never ready stores nothing', async () => {
  const noFrame = await runClaude({ rect: null })
  assert.equal(noFrame.r.stored, false)
  assert.equal(noFrame.cli.calls.some((c) => c[0] === 'screenshot'), false)
  const notReady = await runClaude({ failOn: 'waitfn' })
  assert.equal(notReady.r.stored, false)
  assert.ok(notReady.logs.some((l) => /never became ready/.test(l)))
})

test('claude capture: a screenshot timeout stores nothing and does not retry', async () => {
  const { r, cli, io } = await runClaude({ failOn: 'screenshot' })
  assert.equal(r.stored, false)
  assert.equal(cli.calls.filter((c) => c[0] === 'screenshot').length, 1)
  assert.deepEqual(io.unlinked, [])
})

test('claude capture: only files inside orca-browser-screenshots are ever unlinked', async () => {
  const outside = await runClaude({ shot: { path: 'C:\\Users\\u\\Documents\\precious.jpg' } })
  assert.equal(outside.r.stored, true)
  assert.deepEqual(outside.io.unlinked, [])
})

test('claude capture: a bad page id is rejected before any CLI call', async () => {
  const cli = fakeCli()
  const store = createThumbStore(tmp())
  const r = await captureClaude({ runCli: cli.run, io: fakeIo().io, store, log: () => {} }, 'a b; rm', claudeItem('abc'), 'v1')
  assert.equal(r.stored, false)
  assert.equal(cli.calls.length, 0)
})

// ---- visuals: command and kill path

test('visual command: no forbidden flags, sandbox kept, host-resolver allowlist present', () => {
  const args = headlessArgs({ profileDir: 'C:/c/profile-1', outFile: 'C:/c/cap.png', url: 'file:///C:/x.html' })
  for (const f of FORBIDDEN_FLAGS) assert.equal(args.some((a) => a.startsWith(f)), false, f)
  const rules = args.find((a) => a.startsWith('--host-resolver-rules='))
  assert.ok(rules?.includes('MAP * ~NOTFOUND'))
  for (const h of ALLOWED_HOSTS) assert.ok(rules?.includes(`EXCLUDE ${h}`), h)
  assert.ok(args.includes('--headless=new'))
  for (const f of ['--no-proxy-server', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy']) assert.ok(args.includes(f), f)
  assert.ok(args.includes('--user-data-dir=C:/c/profile-1'))
  assert.equal(args[args.length - 1], 'file:///C:/x.html')
  assert.throws(() => headlessArgs({ profileDir: 'p', outFile: 'o', url: 'https://evil.example/' }), /file:/)
  assert.throws(() => headlessArgs({ profileDir: 'p', outFile: 'o', url: 'file:///a b' }), /file:/)
})

function fakeProc(opts: { exit?: 'immediate' | 'never'; outSize?: number; mtimeMs?: number; errorEvent?: Error; throwOnSpawn?: Error } = {}) {
  const killed: number[] = []
  const rms: string[] = []
  const spawned: { file: string; args: string[] }[] = []
  const logs: string[] = []
  const now = 10_000
  const proc: ProcDeps = {
    platform: 'win32',
    spawn(file, args) {
      if (opts.throwOnSpawn) throw opts.throwOnSpawn
      spawned.push({ file, args })
      const cbs: Record<string, (...a: unknown[]) => void> = {}
      const child: ChildLike = {
        pid: 4321,
        kill: () => {},
        once(ev, cb) { cbs[ev] = cb }
      }
      if (opts.errorEvent) queueMicrotask(() => cbs.error?.(opts.errorEvent))
      else if (opts.exit !== 'never') queueMicrotask(() => cbs.exit?.(0, null))
      return child
    },
    killTree: async (pid) => { killed.push(pid) },
    stat: async () => {
      if (opts.outSize === -1) throw new Error('ENOENT')
      return { size: opts.outSize ?? 5000, mtimeMs: opts.mtimeMs ?? now }
    },
    rm: async (p) => { rms.push(p) },
    now: () => now
  }
  return { proc, killed, rms, spawned, logs }
}

const RUN = { profileDir: 'P', outFile: 'O', url: 'file:///a.html' }

test('runHeadless: success needs an output > 2 KB; the profile dir is always removed', async () => {
  const ok = fakeProc()
  assert.deepEqual(await runHeadless(ok.proc, { sleep: noSleep }, 'edge.exe', RUN), { ok: true })
  assert.deepEqual(ok.rms, ['P'])
  assert.deepEqual(ok.killed, [])
  const tiny = fakeProc({ outSize: 100 })
  assert.equal((await runHeadless(tiny.proc, { sleep: noSleep }, 'edge.exe', RUN)).ok, false)
  const none = fakeProc({ outSize: -1 })
  assert.equal((await runHeadless(none.proc, { sleep: noSleep }, 'edge.exe', RUN)).ok, false)
  assert.deepEqual(none.rms, ['P'])
})

test('runHeadless: a hung browser is killed as a tree after the timeout and cleaned up', async () => {
  const hung = fakeProc({ exit: 'never' })
  const r = await runHeadless(hung.proc, { sleep: noSleep }, 'edge.exe', RUN, { timeoutMs: 20 })
  assert.deepEqual(r, { ok: false, reason: 'the browser timed out' })
  assert.deepEqual(hung.killed, [4321])
  assert.deepEqual(hung.rms, ['P'])
})

test('runHeadless: aborting kills the browser too; rm is retried once after a failure', async () => {
  const hung = fakeProc({ exit: 'never' })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 10)
  assert.equal((await runHeadless(hung.proc, { sleep: noSleep }, 'edge.exe', RUN, { signal: ac.signal })).ok, false)
  assert.deepEqual(hung.killed, [4321])
  const flaky = fakeProc()
  let n = 0
  flaky.proc.rm = async (p) => { flaky.rms.push(p); if (n++ === 0) throw new Error('EBUSY') }
  assert.equal((await runHeadless(flaky.proc, { sleep: noSleep }, 'edge.exe', RUN)).ok, true)
  assert.deepEqual(flaky.rms, ['P', 'P'])
})

// ---- paths

const winEnv = (existing: string[]): PathsEnv => ({ home: 'C:\\Users\\u', platform: 'win32', env: {}, exists: (p) => existing.includes(p), readText: () => null })

test('thumbsDir sits next to the index cache; findBrowser prefers the setting, then Edge, then Chrome', () => {
  assert.equal(thumbsDir(winEnv([])), 'C:\\Users\\u\\AppData\\Local\\orca-artifacts\\thumbs')
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  assert.equal(findBrowser('', winEnv([edge, chrome])).path, edge)
  assert.equal(findBrowser('', winEnv([chrome])).path, chrome)
  assert.equal(findBrowser('D:\\b\\chrome.exe', winEnv(['D:\\b\\chrome.exe', edge])).path, 'D:\\b\\chrome.exe')
  assert.match(findBrowser('D:\\nope.exe', winEnv([edge])).reason ?? '', /does not exist/)
  assert.match(findBrowser('D:\\b\\chrome.cmd', winEnv(['D:\\b\\chrome.cmd'])).reason ?? '', /\.cmd/)
  assert.match(findBrowser('', winEnv([])).reason ?? '', /No Edge or Chrome/)
})

// ---- manager

type ManagerOver = {
  enabled?: boolean
  browser?: string | null
  proc?: ProcDeps
  io?: CaptureIo
  stat?: (p: string) => Promise<{ mtimeMs: number; size: number }>
}

function manager(over: ManagerOver = {}) {
  const dir = tmp()
  let stored = 0
  const cli = fakeCli()
  const fp = fakeProc()
  const m = createThumbManager({
    dir,
    log: () => {},
    enabled: () => over.enabled ?? true,
    browser: () => (over.browser === null ? { path: null, reason: 'No Edge or Chrome found' } : { path: over.browser ?? 'edge.exe' }),
    runCli: cli.run,
    onStored: () => void stored++,
    io: over.io ?? fakeIo().io,
    proc: over.proc ?? fp.proc,
    stat: over.stat ?? (async () => ({ mtimeMs: 5000, size: 42 }))
  })
  return { m, dir, stored: () => stored, cli, fp }
}

const visual = (): Item => ({ ...claudeItem('x'), key: 'visual:c/x.html', kind: 'visual', url: 'file:///C:/x.html', filePath: 'C:/x.html', versions: [] })

test('manager: capture-on-open stores a raw capture, posts, and the item then lists a thumb', async () => {
  const { m, stored } = manager()
  const item = claudeItem('abc')
  assert.deepEqual(await m.get(item), { kind: 'none', reason: 'Open the artifact once to get a preview' })
  m.captureOpened('page-1', item)
  m.captureOpened('page-1', item) // deduped while in flight
  await m.idle()
  assert.equal(stored(), 1)
  assert.equal((await m.fill([{ ...item }]))[0].thumb, 'v1')
  const res = await m.get(item)
  assert.equal(res.kind, 'raw')
  if (res.kind === 'raw') {
    assert.equal(res.rev, 'v1')
    assert.match(res.dataUrl, /^data:image\/jpeg;base64,/)
    assert.deepEqual(res.crop, { x: 0, y: 45, w: 800, h: 600 })
  }
})

test('manager: an artifact that already has a thumb for its rev is not captured again', async () => {
  const { m, cli } = manager()
  const item = claudeItem('abc')
  m.captureOpened('p', item)
  await m.idle()
  const calls = cli.calls.length
  m.captureOpened('p', item)
  await m.idle()
  assert.equal(cli.calls.length, calls)
})

test('manager: a stale claude thumb is shown until the new revision is captured', async () => {
  const { m } = manager()
  m.captureOpened('p', claudeItem('abc'))
  await m.idle()
  const v2 = claudeItem('abc', { versions: [{ at: 2, sessionId: 's', action: 'update', version: 'v2' }] })
  assert.equal((await m.fill([{ ...v2 }]))[0].thumb, 'v1')
  const res = await m.get(v2)
  assert.equal(res.kind === 'raw' && res.rev, 'v1')
  m.captureOpened('p', v2)
  await m.idle()
  assert.equal((await m.fill([{ ...v2 }]))[0].thumb, 'v2')
})

test('manager: visual capture is queued once, answers capturing, then raw png', async () => {
  const fp = fakeProc()
  const { m, dir, stored } = manager({
    proc: {
      ...fp.proc,
      spawn(file, args) {
        // The fake browser writes its screenshot where it was told to.
        const out = args.find((a) => a.startsWith('--screenshot='))!.slice('--screenshot='.length)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, Buffer.alloc(5000, 1))
        return fp.proc.spawn(file, args)
      }
    },
    io: { readFile: async (p) => fs.readFileSync(p), unlink: async (p) => fs.rmSync(p, { force: true }), sleep: noSleep }
  })
  const v = visual()
  assert.deepEqual(await m.get(v), { kind: 'capturing' })
  assert.deepEqual(await m.get(v), { kind: 'capturing' })
  await m.idle()
  assert.equal(fp.spawned.length, 1)
  assert.equal(stored(), 1)
  const res = await m.get(v)
  assert.equal(res.kind, 'raw')
  if (res.kind === 'raw') {
    assert.match(res.dataUrl, /^data:image\/png;base64,/)
    assert.equal(res.crop, null)
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => /^cap-/.test(n)), []) // temp png removed
  assert.equal((await m.fill([{ ...v }]))[0].thumb, '5000-42')
})

test('manager: a failed visual capture answers none and is not retried for that rev', async () => {
  const fp = fakeProc({ outSize: -1 })
  const { m } = manager({ proc: fp.proc })
  const v = visual()
  assert.deepEqual(await m.get(v), { kind: 'capturing' })
  await m.idle()
  assert.equal((await m.get(v)).kind, 'none')
  await m.idle()
  assert.equal(fp.spawned.length, 1)
})

test('manager: no browser, disabled, and unreadable files answer none without spawning', async () => {
  const fp = fakeProc()
  const a = manager({ browser: null, proc: fp.proc })
  assert.deepEqual(await a.m.get(visual()), { kind: 'none', reason: 'No Edge or Chrome found' })
  const b = manager({ enabled: false, proc: fp.proc })
  assert.equal((await b.m.get(visual())).kind, 'none')
  b.m.captureOpened('p', claudeItem('abc'))
  await b.m.idle()
  assert.equal(b.cli.calls.length, 0)
  const c = manager({ stat: async () => { throw new Error('gone') }, proc: fp.proc })
  assert.equal((await c.m.get(visual())).kind, 'none')
  assert.equal(fp.spawned.length, 0)
})

test('manager: store validates the pending raw, JPEG data URL and 200 KB cap; the final then replaces the raw', async () => {
  const { m, dir } = manager()
  const item = claudeItem('abc')
  const good = `data:image/jpeg;base64,${jpeg(1000).toString('base64')}`
  assert.deepEqual(await m.store(item, 'v1', good), { ok: false, reason: 'No pending capture for that rev' })
  m.captureOpened('p', item)
  await m.idle()
  assert.equal((await m.store(item, 'v9', good)).ok, false) // rev does not match
  assert.equal((await m.store(item, 'v1', 'data:image/png;base64,AAAA')).ok, false)
  assert.equal((await m.store(item, 'v1', 'data:image/jpeg;base64,not base64!')).ok, false)
  const notJpeg = `data:image/jpeg;base64,${Buffer.alloc(100, 1).toString('base64')}`
  assert.deepEqual(await m.store(item, 'v1', notJpeg), { ok: false, reason: 'Not a JPEG image' })
  const big = `data:image/jpeg;base64,${jpeg(201 * 1024).toString('base64')}`
  assert.equal((await m.store(item, 'v1', big)).ok, false)
  assert.deepEqual(await m.store(item, 'v1', good), { ok: true })
  assert.equal((await m.get(item)).kind, 'ready')
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.raw')).length, 0)
  assert.equal((await m.store(item, 'v1', good)).ok, false) // nothing pending any more
})

test('manager: clearAll wipes the store and forgets failures', async () => {
  const { m, dir } = manager()
  m.captureOpened('p', claudeItem('abc'))
  await m.idle()
  assert.ok(fs.existsSync(dir))
  await m.clearAll()
  assert.equal(fs.existsSync(dir), false)
  assert.equal((await m.fill([claudeItem('abc')]))[0].thumb, undefined)
})

// ---- review fixes

const waitUntil = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A manager whose fake browser writes the screenshot it was told to, with a mutable enabled flag / file stat. */
function visualRig(opts: { exit?: 'immediate' | 'never'; outSize?: number; clearWaitMs?: number; hangKill?: boolean } = {}) {
  const dir = tmp()
  const fp = fakeProc({ exit: opts.exit, outSize: opts.outSize })
  const state = { enabled: true, mtime: 5000, size: 42, posts: 0 }
  const logs: string[] = []
  const proc: ProcDeps = {
    ...fp.proc,
    spawn(file, args) {
      const out = args.find((a) => a.startsWith('--screenshot='))!.slice('--screenshot='.length)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.alloc(5000, 1))
      return fp.proc.spawn(file, args)
    },
    ...(opts.hangKill ? { killTree: () => new Promise<void>(() => {}) } : {})
  }
  const m = createThumbManager({
    dir,
    log: (x) => logs.push(x),
    enabled: () => state.enabled,
    browser: () => ({ path: 'edge.exe' }),
    runCli: fakeCli().run,
    onStored: () => void state.posts++,
    io: { readFile: async (p) => fs.readFileSync(p), unlink: async (p) => fs.rmSync(p, { force: true }), sleep: noSleep },
    proc,
    stat: async () => ({ mtimeMs: state.mtime, size: state.size }),
    clearWaitMs: opts.clearWaitMs
  })
  return { m, dir, fp, state, logs }
}

const goodJpegUrl = (): string => `data:image/jpeg;base64,${jpeg(1000).toString('base64')}`

test('visual: turning previews off aborts a running capture (killed, nothing stored); turning them on captures again', async () => {
  const r = visualRig({ exit: 'never' })
  const v = visual()
  assert.deepEqual(await r.m.get(v), { kind: 'capturing' })
  await waitUntil(() => r.fp.spawned.length === 1)
  r.state.enabled = false
  r.m.abortAll()
  await r.m.idle()
  assert.deepEqual(r.fp.killed, [4321])
  assert.equal(await r.m.store_.has(v.key, '5000-42'), false)
  assert.equal(r.state.posts, 1) // the panel is told to re-ask
  assert.ok(r.logs.some((l) => /aborted/.test(l)))
  r.state.enabled = true
  assert.deepEqual(await r.m.get(v), { kind: 'capturing' }) // an abort is not remembered as a failure
  await waitUntil(() => r.fp.spawned.length === 2)
  r.m.abortAll()
  await r.m.idle()
})

test('visual: raw png becomes the final jpg through store, leaving no .raw.png / .raw.json', async () => {
  const r = visualRig()
  const v = visual()
  await r.m.get(v)
  await r.m.idle()
  assert.equal((await r.m.get(v)).kind, 'raw')
  assert.ok(fs.readdirSync(r.dir).some((n) => n.endsWith('.raw.png')))
  assert.ok(fs.readdirSync(r.dir).some((n) => n.endsWith('.raw.json')))
  assert.deepEqual(await r.m.store(v, '5000-42', goodJpegUrl()), { ok: true })
  assert.deepEqual(fs.readdirSync(r.dir), [`${hashKey(v.key)}-5000-42.jpg`])
  assert.equal((await r.m.get(v)).kind, 'ready')
})

test('visual: a failed capture is retried once the file changes, and each end without a thumb notifies the panel', async () => {
  const r = visualRig({ outSize: -1 })
  const v = visual()
  assert.deepEqual(await r.m.get(v), { kind: 'capturing' })
  await r.m.idle()
  assert.equal(r.state.posts, 1)
  assert.equal((await r.m.get(v)).kind, 'none')
  assert.equal(r.fp.spawned.length, 1)
  r.state.mtime = 6000
  assert.deepEqual(await r.m.get(v), { kind: 'capturing' })
  await r.m.idle()
  assert.equal(r.fp.spawned.length, 2)
  assert.ok(r.logs.some((l) => /thumb visual:c\/x\.html: .*no capture.*exit code 0.*\(browser edge\.exe\)/.test(l)))
})

test('visual: a changed rev serves the stale image and queues a capture of the current one', async () => {
  const r = visualRig()
  const v = visual()
  await r.m.get(v)
  await r.m.idle()
  r.state.mtime = 7000
  assert.equal((await r.m.fill([{ ...v }]))[0].thumb, '5000-42') // stale rev listed
  const res = await r.m.get(v)
  assert.equal(res.kind === 'raw' && res.rev, '5000-42')
  await r.m.idle()
  assert.equal(r.fp.spawned.length, 2)
  assert.equal((await r.m.fill([{ ...v }]))[0].thumb, '7000-42')
  assert.equal((await r.m.get(v)).kind === 'raw' && ((await r.m.get(v)) as { rev: string }).rev, '7000-42')
})

test('visual: a url that is not file:/// never spawns a browser', async () => {
  const r = visualRig()
  const v = { ...visual(), url: 'https://evil.example/x.html' }
  await r.m.get(v)
  await r.m.idle()
  assert.equal(r.fp.spawned.length, 0)
  const res = await r.m.get(v)
  assert.equal(res.kind === 'none' && /file:/.test(res.reason ?? ''), true)
})

test('visual: a missing browser is logged once per distinct reason', async () => {
  const logs: string[] = []
  const m = createThumbManager({
    dir: tmp(), log: (x) => logs.push(x), enabled: () => true, browser: () => ({ path: null, reason: 'nope' }), runCli: fakeCli().run,
    onStored: () => {}, io: fakeIo().io, proc: fakeProc().proc, stat: async () => ({ mtimeMs: 1, size: 1 })
  })
  for (let i = 0; i < 3; i++) assert.deepEqual(await m.get(visual()), { kind: 'none', reason: 'nope' })
  assert.equal(logs.filter((l) => /no browser/.test(l)).length, 1)
})

test('manager: clearAll does not wait longer than its limit for a stuck capture', async () => {
  const r = visualRig({ exit: 'never', hangKill: true, clearWaitMs: 30 })
  await r.m.get(visual())
  await waitUntil(() => r.fp.spawned.length === 1)
  await r.m.clearAll() // the chain never settles (taskkill hangs): must still return
  assert.ok(r.logs.some((l) => /clearAll did not wait/.test(l)))
})

test('manager: aborting during a claude capture stores nothing and posts nothing, even once the CLI answers', async () => {
  const cli = fakeCli()
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  let posts = 0
  const dir = tmp()
  const m = createThumbManager({
    dir, log: () => {}, enabled: () => true, browser: () => ({ path: null }),
    runCli: async (args) => {
      if (args[0] === 'screenshot') await gate
      return cli.run(args)
    },
    onStored: () => void posts++, io: fakeIo().io, proc: fakeProc().proc
  })
  m.captureOpened('p', claudeItem('abc'))
  await waitUntil(() => cli.calls.length >= 3 || cli.calls.some((c) => c[0] === 'screenshot'))
  m.abortAll()
  release()
  await m.idle()
  assert.equal(posts, 0)
  assert.equal(await m.store_.has('claude:abc', 'v1'), false)
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [])
  assert.equal((await m.get(claudeItem('abc'))).kind, 'none')
})

test('manager: a claude capture failure is remembered per rev and explained once the item was opened', async () => {
  const dir = tmp()
  const cli = fakeCli({ path: '/chats/elsewhere' })
  const m = createThumbManager({
    dir, log: () => {}, enabled: () => true, browser: () => ({ path: null }), runCli: cli.run, onStored: () => {}, io: fakeIo().io, proc: fakeProc().proc
  })
  const item = claudeItem('abc')
  assert.deepEqual(await m.get(item), { kind: 'none', reason: 'Open the artifact once to get a preview' })
  m.captureOpened('p', item)
  await m.idle()
  const res = await m.get(item)
  assert.equal(res.kind === 'none' && /probe: tab is on \/chats\/elsewhere, not \/artifact\/abc/.test(res.reason ?? ''), true)
})

test('claude capture: aborting mid-way stores nothing, still cleans the temp screenshot, and logs it', async () => {
  const ac = new AbortController()
  const store = createThumbStore(tmp())
  const io = fakeIo()
  const logs: string[] = []
  const cli = fakeCli()
  const run = async (args: string[]): Promise<unknown> => {
    const out = await cli.run(args)
    if (args[0] === 'screenshot') ac.abort()
    return out
  }
  const r = await captureClaude({ runCli: run, io: io.io, store, signal: ac.signal, log: (m) => logs.push(m) }, 'page-1', claudeItem('abc'), 'v1')
  assert.equal(r.stored, false)
  assert.equal(await store.has('claude:abc', 'v1'), false)
  assert.deepEqual(io.unlinked, [SHOT])
  assert.ok(logs.includes('thumb claude:abc: aborted'))
  assert.equal(cli.calls.filter((c) => c[0] === 'eval').length, 1) // no recheck after the abort
})

test('claude capture: failures name their step; probe output vs wrong tab are told apart; screenshot output is included', async () => {
  const run = (evalOut: unknown, shot: unknown) => async (args: string[]): Promise<unknown> => {
    if (args[0] === 'eval') return evalOut
    if (args[0] === 'screenshot') return shot
    return {}
  }
  const go = async (cli: (a: string[]) => Promise<unknown>) => {
    const logs: string[] = []
    const r = await captureClaude({ runCli: cli, io: fakeIo().io, store: createThumbStore(tmp()), log: (m) => logs.push(m) }, 'p', claudeItem('abc'), 'v1')
    return { r, logs }
  }
  const garbage = await go(run({ result: 'oops' }, {}))
  assert.match(garbage.logs[0], /^thumb claude:abc: probe: unparseable eval output /)
  const wrong = await go(run({ result: JSON.stringify({ path: '/chats/x', r: null }) }, {}))
  assert.equal(wrong.logs[0], 'thumb claude:abc: probe: tab is on /chats/x, not /artifact/abc')
  const noFile = await go(run({ result: JSON.stringify({ path: '/artifact/abc', r: { x: 0, y: 45, width: 800, height: 600 } }) }, { note: 'timed out' }))
  assert.equal(noFile.logs[0], 'thumb claude:abc: screenshot: returned no file (output: {"note":"timed out"})')
  const noFrame = await go(async (a) => (a[0] === 'wait' && a.includes('--fn') ? Promise.reject(new CliError('cli_timeout', 'late')) : {}))
  assert.match(noFrame.logs[0], /^thumb claude:abc: wait-frame: artifact frame never became ready/)
})

test('claude capture: a raw larger than 700 KB is rejected and the temp file removed', async () => {
  const big = Buffer.concat([sofJpeg(1000, 700), Buffer.alloc(701 * 1024)])
  const { r, io, logs, store } = await runClaude({}, fakeIo(big))
  assert.equal(r.stored, false)
  assert.ok(logs.some((l) => /read: capture too large for the panel \(\d+ KB\)/.test(l)))
  assert.deepEqual(io.unlinked, [SHOT])
  assert.equal(await store.has('claude:abc', 'v1'), false)
})

test('claude capture: a frame smaller than 16 px stores nothing and the temp file is removed', async () => {
  const { r, io, store } = await runClaude({ rect: { x: 0, y: 45, width: 10, height: 600 } })
  assert.equal(r.stored, false)
  assert.deepEqual(io.unlinked, [SHOT])
  assert.equal(await store.has('claude:abc', 'v1'), false)
})

test('manager: a raw whose base64 would not fit the answer limit is not served', async () => {
  const dir = tmp()
  const m = createThumbManager({
    dir, log: () => {}, enabled: () => true, browser: () => ({ path: null }), runCli: fakeCli().run, onStored: () => {}, io: fakeIo().io, proc: fakeProc().proc
  })
  const item = claudeItem('abc')
  await m.store_.putRaw(item.key, 'v1', Buffer.alloc(800 * 1024, 5), 'jpg', null)
  const res = await m.get(item)
  assert.equal(res.kind, 'none')
})

test('store: LRU also caps total bytes, evicting the oldest first', async () => {
  const dir = tmp()
  const s = createThumbStore(dir)
  const mb8 = 8 * 1024 * 1024
  for (let i = 0; i < 4; i++) await s.putFinal(`claude:big${i}`, 'v1', jpeg(mb8))
  assert.ok(4 * mb8 > MAX_BYTES)
  assert.equal(await s.has('claude:big0', 'v1'), false)
  assert.equal(await s.has('claude:big3', 'v1'), true)
  assert.equal(fs.readdirSync(dir).length, 3)
})

test('runHeadless: a stale output file is rejected', async () => {
  const stale = fakeProc({ mtimeMs: 1000 })
  const r = await runHeadless(stale.proc, { sleep: noSleep }, 'edge.exe', RUN)
  assert.equal(r.ok === false && /stale/.test(r.reason), true)
  assert.deepEqual(stale.rms, ['P'])
})

test('runHeadless: a spawn error event keeps its code and message, kills the child and cleans the profile', async () => {
  const err = Object.assign(new Error('spawn denied'), { code: 'EACCES' })
  const p = fakeProc({ errorEvent: err })
  const r = await runHeadless(p.proc, { sleep: noSleep }, 'edge.exe', RUN)
  assert.deepEqual(r, { ok: false, reason: 'the browser could not start (EACCES spawn denied)' })
  assert.deepEqual(p.rms, ['P'])
})

test('runHeadless: a synchronous spawn throw is a reason and still cleans the profile', async () => {
  const p = fakeProc({ throwOnSpawn: new Error('boom') })
  assert.deepEqual(await runHeadless(p.proc, { sleep: noSleep }, 'edge.exe', RUN), { ok: false, reason: 'boom' })
  assert.deepEqual(p.rms, ['P'])
  assert.equal(p.spawned.length, 0)
})

test('runHeadless: a missing output reports the exit code and the stat error; rm failures are logged', async () => {
  const p = fakeProc({ outSize: -1 })
  p.proc.rm = async () => { throw new Error('EBUSY locked') }
  const logs: string[] = []
  const r = await runHeadless(p.proc, { sleep: noSleep }, 'edge.exe', RUN, { log: (m) => logs.push(m) })
  assert.equal(r.ok === false && /no capture \(exit code 0; ENOENT\)/.test(r.reason), true)
  assert.ok(logs.some((l) => /cannot remove profile P: EBUSY locked/.test(l)))
})

/** An AbortSignal stand-in that counts listeners. */
function countingSignal() {
  const live = new Set<unknown>()
  const sig = {
    aborted: false,
    addEventListener: (_: string, cb: unknown) => void live.add(cb),
    removeEventListener: (_: string, cb: unknown) => void live.delete(cb)
  }
  return { sig: sig as unknown as AbortSignal, live }
}

test('runHeadless and defaultIo.sleep do not leak abort listeners', async () => {
  const a = countingSignal()
  assert.equal((await runHeadless(fakeProc().proc, { sleep: noSleep }, 'edge.exe', RUN, { signal: a.sig })).ok, true)
  assert.equal(a.live.size, 0)
  const b = countingSignal()
  await defaultIo.sleep(5, b.sig)
  assert.equal(b.live.size, 0)
})
