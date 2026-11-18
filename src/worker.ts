import type { OrcaWorkerApi } from 'orca/worker'
import type { Item, ListContext, ListResponse, OpenResult, Scope, SessionRef, ThumbResult } from './types.ts'
import { resolveScope } from './scope.ts'
import { CliError, createCliRunner, defaultFinderEnv, extractPageId, resolveCli, tabCreateArgs, tabFocusArgs } from './cli.ts'
import { createThumbManager, type CaptureIo, type ProcDeps, type ThumbManager } from './thumbs.ts'
import { cacheFilePath, defaultPathsEnv, findBrowser, projectsDirsReport, thumbsDir, type PathsEnv, type ProjectsDirsReport } from './paths.ts'

export type IndexerLike = {
  load(): Promise<void>
  scan(
    roots: string[],
    signal?: AbortSignal
  ): Promise<{ changed: boolean; filesRead: number; failed?: number; cacheWriteError?: string }>
  query(roots: string[]): { items: Item[]; sessions: Record<string, SessionRef> }
  clear(): Promise<void>
  readonly rev: number
  readonly lastIndexedAt: number | null
}

export type IndexerOpts = { cacheFile: string; projectsDirs: string[]; log: (msg: string) => void }

export type WorkerSettings = { cliPath: string; claudeDirs: string; visualPreviews: boolean; browserPath: string }

export type WorkerDeps = {
  createIndexer(opts: IndexerOpts, settings: WorkerSettings): IndexerLike
  /** Runs `orca <args> --json`; rejects with CliError('cli_not_found') when the CLI is missing. */
  runCli(args: string[], timeoutMs: number, cliPathSetting?: string): Promise<unknown>
  killCli(): void
  config?: Partial<typeof DEFAULTS>
  /** Where Claude's folders and the cache live; defaults to the real machine. */
  pathsEnv?: PathsEnv
  /** Test seams for thumbnail capture (process spawning, file reads, sleeping). */
  thumbIo?: { io?: CaptureIo; proc?: ProcDeps }
  /** Overrides where thumbnails are stored (tests). */
  thumbsDir?: string
}

const snippet = (v: unknown): string => {
  let t: string
  try {
    t = JSON.stringify(v) ?? String(v)
  } catch {
    t = String(v)
  }
  return t.length > 160 ? `${t.slice(0, 160)}...` : t
}

const DEFAULTS = {
  throttleMs: 1000,
  staleMs: 30_000,
  debounceMs: 3000,
  loadWaitMs: 5000,
  openTimeoutMs: 15_000,
  rootsTtlMs: 30 * 60_000
}
const MAX_PINS = 500
const OPEN_URL = /^(https:\/\/claude\.ai\/(code\/)?artifact\/|file:\/\/\/)/
const CLI_HINT = 'Orca CLI not found. Set its path in the plugin settings ("Orca CLI path").'

const rootKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'invalid_params' })

const emptyContext: ListContext = { worktreePath: null, worktreeName: null, repoName: null, worktrees: [] }

export function createWorker(deps: WorkerDeps): {
  activate(orca: OrcaWorkerApi): Promise<void>
  deactivate(): Promise<void>
} {
  const cfg = { ...DEFAULTS, ...deps.config }
  let orca: OrcaWorkerApi
  let settings: WorkerSettings = { cliPath: '', claudeDirs: '', visualPreviews: true, browserPath: '' }
  let thumbs: ThumbManager | null = null
  let indexer: IndexerLike
  let loadPromise: Promise<void> = Promise.resolve()
  let scan: AbortController | null = null
  let scanError: string | null = null
  let thumbClearFailed = false
  let builtDirsKey = ''
  let pinChain: Promise<unknown> = Promise.resolve()
  let lastPostAt = 0
  let trailing: ReturnType<typeof setTimeout> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const scannedAt = new Map<string, number>()
  /** Roots requested recently, key -> {path, at}. */
  const known = new Map<string, { path: string; at: number }>()
  const disposables: { dispose(): void }[] = []

  const host = () => orca.host as unknown as Parameters<typeof resolveScope>[0]

  function readSettings(raw: Record<string, unknown> | undefined): WorkerSettings {
    const vp = raw?.visualPreviews
    return {
      cliPath: String(raw?.cliPath ?? ''),
      claudeDirs: String(raw?.claudeDirs ?? ''),
      visualPreviews: !(vp === false || (typeof vp === 'string' && /^(false|off|no|0)$/i.test(vp.trim()))),
      browserPath: String(raw?.browserPath ?? '')
    }
  }

  const pathsEnv = (): PathsEnv => deps.pathsEnv ?? defaultPathsEnv()
  const dirsReport = (): ProjectsDirsReport => projectsDirsReport(settings.claudeDirs, pathsEnv(), (m) => orca.log(m))

  function buildIndexer(report: ProjectsDirsReport = dirsReport()): void {
    scanError = null
    builtDirsKey = report.dirs.join('\n')
    orca.log(`indexer: ${report.dirs.length} projects dir(s)`)
    indexer = deps.createIndexer(
      { cacheFile: cacheFilePath(pathsEnv()), projectsDirs: report.dirs, log: (m) => orca.log(m) },
      settings
    )
    loadPromise = indexer.load().catch((e) => orca.log(`indexer load failed: ${errMsg(e)}`))
  }

  function doPost(): void {
    lastPostAt = Date.now()
    try {
      orca.panels.post('artifacts.changed', { rev: indexer.rev, indexing: scan !== null })
    } catch (e) {
      orca.log(`panels.post failed: ${errMsg(e)}`)
    }
  }

  /** At most one post per throttle window; a late one is coalesced into a trailing post. */
  function postChanged(): void {
    if (disposed) return
    const wait = lastPostAt + cfg.throttleMs - Date.now()
    if (wait <= 0) doPost()
    else if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null
        if (!disposed) doPost()
      }, wait)
    }
  }

  function remember(roots: string[]): void {
    const now = Date.now()
    for (const r of roots) known.set(rootKey(r), { path: r, at: now })
    for (const [k, v] of known) if (now - v.at > cfg.rootsTtlMs) known.delete(k)
    while (known.size > 50) known.delete(known.keys().next().value as string)
  }

  const scanRoots = (): string[] => [...known.values()].map((v) => v.path)

  function needsScan(roots: string[]): boolean {
    const now = Date.now()
    return roots.some((r) => {
      const at = scannedAt.get(rootKey(r))
      return at === undefined || now - at > cfg.staleMs
    })
  }

  /** Starts a background scan unless one is running. Never awaited by request handlers. */
  function startScan(): boolean {
    if (scan || disposed) return false
    const roots = scanRoots()
    if (roots.length === 0) return false
    const report = dirsReport()
    if (report.dirs.join('\n') !== builtDirsKey) buildIndexer(report)
    const mine = new AbortController()
    scan = mine
    doPost()
    void (async () => {
      try {
        await loadPromise
        const r = await indexer.scan(roots, mine.signal)
        if (mine.signal.aborted) return
        const parts: string[] = []
        if (r.failed && r.failed > 0) parts.push(`Could not read ${r.failed} transcript file(s) (see \`orca plugin logs\`)`)
        if (r.cacheWriteError) {
          orca.log(`index cache write failed: ${r.cacheWriteError}`)
          parts.push('index cache could not be saved')
        }
        if (thumbClearFailed) parts.push('thumbnail cache could not be cleared')
        scanError = parts.length > 0 ? parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : null
        orca.log(`scan done: ${roots.length} root(s), ${r.filesRead} file(s) read, changed=${r.changed}, failed=${r.failed ?? 0}`)
      } catch (e) {
        if (!mine.signal.aborted) {
          scanError = `Indexing failed: ${errMsg(e)}`
          orca.log(scanError)
        }
      } finally {
        if (scan === mine) {
          scan = null
          const now = Date.now()
          for (const r of roots) scannedAt.set(rootKey(r), now)
          if (!mine.signal.aborted && !disposed) {
            postChanged()
            // A root that arrived while this scan ran has not been scanned yet.
            if (scanRoots().some((r) => !scannedAt.has(rootKey(r)))) startScan()
          }
        }
      }
    })()
    return true
  }

  /** Reads pins; rethrows so a write based on it can never clobber stored pins. */
  async function readPinsStrict(): Promise<string[]> {
    const v = await orca.storage.get('pins')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }

  async function readPinsLenient(): Promise<{ pins: string[]; failed: boolean }> {
    try {
      return { pins: await readPinsStrict(), failed: false }
    } catch (e) {
      orca.log(`pins read failed: ${errMsg(e)}`)
      return { pins: [], failed: true }
    }
  }

  async function waitLoaded(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([loadPromise, new Promise<void>((res) => (timer = setTimeout(res, cfg.loadWaitMs)))])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function list(scope: Scope): Promise<ListResponse> {
    if (scope !== 'repo' && scope !== 'worktree') throw invalid('scope must be "repo" or "worktree"')
    const { pins, failed: pinsFailed } = await readPinsLenient()
    let context = emptyContext
    let roots: string[] = []
    let error: string | undefined
    try {
      const r = await resolveScope(host(), scope, (m) => orca.log(m))
      context = r.context
      roots = r.roots
      error = r.error
    } catch (e) {
      error = errMsg(e)
    }
    await waitLoaded()
    const report = dirsReport()
    const dirsError =
      report.dirs.length === 0
        ? `No Claude projects folder found (looked in: ${report.looked.join(', ') || 'nowhere'}).${
            report.missingConfigured.length > 0 ? ` Configured folder(s) not found: ${report.missingConfigured.join(', ')}.` : ''
          } Check the 'Claude config folders' setting.`
        : undefined
    if (roots.length > 0) {
      remember(roots)
      if (!scan && needsScan(roots)) startScan()
    }
    let items: Item[] = []
    let sessions: Record<string, SessionRef> = {}
    if (roots.length > 0) {
      try {
        ;({ items, sessions } = indexer.query(roots))
      } catch (e) {
        error = `Index query failed: ${errMsg(e)}`
        orca.log(error)
      }
    }
    if (items.length > 0 && thumbs) {
      try {
        items = await thumbs.fill(items.map((i) => ({ ...i })))
      } catch (e) {
        orca.log(`thumbs fill failed: ${errMsg(e)}`)
      }
    }
    return {
      rev: indexer.rev,
      indexing: scan !== null,
      scope,
      context,
      items,
      sessions,
      pins,
      lastIndexedAt: indexer.lastIndexedAt,
      ...(((e) => (e ? { error: e } : {}))(error ?? dirsError ?? scanError ?? (pinsFailed ? 'Could not read pins' : undefined)))
    }
  }

  async function refresh(full: boolean): Promise<{ started: boolean; reason?: string }> {
    if (disposed) return { started: false, reason: 'Worker is stopping' }
    if (known.size === 0) {
      try {
        const r = await resolveScope(host(), 'repo')
        if (r.roots.length === 0) return { started: false, reason: r.error ?? 'No worktrees to scan' }
        remember(r.roots)
      } catch (e) {
        orca.log(`refresh: no roots (${errMsg(e)})`)
        return { started: false, reason: errMsg(e) }
      }
    }
    if (full) {
      scan?.abort()
      // Hold the slot while clearing so a list/pin in the gap neither posts "not indexing" nor starts a scan.
      const gate = new AbortController()
      scan = gate
      scanError = null
      thumbClearFailed = false
      scannedAt.clear()
      try {
        await indexer.clear()
        try {
          await thumbs?.clearAll()
        } catch (e) {
          thumbClearFailed = true
          scanError = 'Thumbnail cache could not be cleared'
          orca.log(`thumbnail cache clear failed: ${errMsg(e)}`)
        }
      } catch (e) {
        if (scan === gate) scan = null
        throw e
      }
      if (scan !== gate) return { started: false, reason: 'Refresh was superseded' }
      scan = null
    }
    return { started: startScan() }
  }

  async function open(key: string): Promise<OpenResult> {
    if (typeof key !== 'string' || !key) throw invalid('key is required')
    let resolved
    try {
      resolved = await resolveScope(host(), 'repo', (m) => orca.log(m))
    } catch (e) {
      return { ok: false, reason: errMsg(e) }
    }
    const { worktreePath } = resolved.context
    if (!worktreePath) return { ok: false, reason: resolved.error ?? 'No workspace focused' }
    let item: Item | undefined
    try {
      await waitLoaded()
      item = indexer.query(resolved.roots).items.find((i) => i.key === key)
    } catch (e) {
      orca.log(`open: index query failed: ${errMsg(e)}`)
      return { ok: false, reason: `Index query failed: ${errMsg(e)}` }
    }
    if (!item) return { ok: false, reason: 'Item not found in the index; try refreshing' }
    if (typeof item.url !== 'string' || !OPEN_URL.test(item.url)) {
      return { ok: false, reason: 'Refusing to open a URL that is not https://claude.ai/... or file:///...' }
    }
    try {
      const created = await deps.runCli(tabCreateArgs(item.url, worktreePath), cfg.openTimeoutMs, settings.cliPath)
      const pageId = extractPageId(created)
      if (pageId) {
        // `tab create` opens the tab without showing it; bring it to the front. The tab is already
        // open, so a failed focus is logged, not reported as a failed open.
        try {
          await deps.runCli(tabFocusArgs(pageId, worktreePath), cfg.openTimeoutMs, settings.cliPath)
        } catch (e) {
          orca.log(`open: could not focus tab ${pageId}: ${errMsg(e)}`)
        }
      } else {
        orca.log(`open ${item.key}: tab create returned no page id (output: ${snippet(created)})`)
      }
      if (item.kind === 'claude' && thumbs && pageId) thumbs.captureOpened(pageId, { ...item })
      return { ok: true }
    } catch (e) {
      orca.log(`open failed: ${errMsg(e)}`)
      return { ok: false, reason: errMsg(e) }
    }
  }

  async function findItem(key: string): Promise<Item | null> {
    if (typeof key !== 'string' || !key || key.length > 500) throw invalid('invalid key')
    const r = await resolveScope(host(), 'repo', (m) => orca.log(m))
    if (r.roots.length === 0) return null
    await waitLoaded()
    return indexer.query(r.roots).items.find((i) => i.key === key) ?? null
  }

  async function thumb(key: string): Promise<ThumbResult> {
    if (!thumbs) return { kind: 'none', reason: 'Previews unavailable' }
    const item = await findItem(key)
    if (!item) return { kind: 'none', reason: 'Item not found in the index' }
    return thumbs.get(item)
  }

  async function thumbStore(key: string, rev: string, dataUrl: string): Promise<{ ok: boolean; reason?: string }> {
    if (!thumbs) return { ok: false, reason: 'Previews unavailable' }
    const item = await findItem(key)
    if (!item) return { ok: false, reason: 'Item not found in the index' }
    return thumbs.store(item, rev, dataUrl)
  }

  /** Serialised: two quick pins must not read the same list and lose one. */
  function pin(key: string, pinned: boolean): Promise<{ pins: string[] }> {
    if (typeof key !== 'string' || !key || key.length > 500) throw invalid('invalid key')
    const run = async (): Promise<{ pins: string[] }> => {
      const rest = (await readPinsStrict()).filter((k) => k !== key)
      const pins = pinned ? [...rest, key].slice(-MAX_PINS) : rest
      await orca.storage.set('pins', pins)
      postChanged()
      return { pins }
    }
    const result = pinChain.then(run)
    pinChain = result.catch(() => {})
    return result
  }

  async function activate(o: OrcaWorkerApi): Promise<void> {
    orca = o
    disposed = false
    try {
      settings = readSettings(await orca.settings.get())
    } catch (e) {
      orca.log(`settings read failed: ${errMsg(e)}`)
    }
    buildIndexer()
    thumbs = createThumbManager({
      dir: deps.thumbsDir ?? thumbsDir(pathsEnv()),
      log: (m) => orca.log(m),
      enabled: () => settings.visualPreviews && !disposed,
      browser: () => findBrowser(settings.browserPath, pathsEnv()),
      runCli: (args, timeoutMs) => deps.runCli(args, timeoutMs, settings.cliPath),
      onStored: () => {
        if (!disposed) postChanged()
      },
      io: deps.thumbIo?.io,
      proc: deps.thumbIo?.proc
    })

    disposables.push(
      orca.panels.handle('artifacts.list', (input) => list((input as { scope: Scope } | undefined)?.scope as Scope)),
      orca.panels.handle('artifacts.refresh', (input) => refresh(Boolean((input as { full?: boolean } | undefined)?.full))),
      orca.panels.handle('artifacts.open', (input) => open((input as { key: string } | undefined)?.key as string)),
      orca.panels.handle('artifacts.thumb', (input) => thumb((input as { key: string } | undefined)?.key as string)),
      orca.panels.handle('artifacts.thumbStore', (input) => {
        const i = input as { key: string; rev: string; dataUrl: string } | undefined
        return thumbStore(i?.key as string, i?.rev as string, i?.dataUrl as string)
      }),
      orca.panels.handle('artifacts.pin', async (input) =>
        pin((input as { key: string })?.key, Boolean((input as { pinned: boolean })?.pinned))
      ),
      orca.events.on('workspace.changed', () => {
        postChanged()
      }),
      orca.events.on('agent.status.changed', (p) => {
        if (p.state !== 'done' && p.state !== 'waiting') return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          startScan()
        }, cfg.debounceMs)
      }),
      orca.settings.onDidChange(() => {
        void (async () => {
          try {
            const next = readSettings(await orca.settings.get())
            const dirsChanged = next.claudeDirs !== settings.claudeDirs
            if (!next.visualPreviews) thumbs?.abortAll()
            settings = next
            if (!dirsChanged) return
            scan?.abort()
            scan = null
            scannedAt.clear()
            buildIndexer()
            postChanged()
          } catch (e) {
            orca.log(`settings change failed: ${errMsg(e)}`)
          }
        })()
      })
    )
    orca.log('artifacts worker ready')
  }

  async function deactivate(): Promise<void> {
    disposed = true
    scan?.abort()
    scan = null
    thumbs?.abortAll()
    if (trailing) clearTimeout(trailing)
    if (debounce) clearTimeout(debounce)
    trailing = debounce = null
    for (const d of disposables.splice(0)) {
      try {
        d.dispose()
      } catch (e) {
        orca.log(`dispose failed: ${errMsg(e)}`)
      }
    }
    deps.killCli()
  }

  return { activate, deactivate }
}

// Real wiring. The indexer is imported lazily so this module loads even where it is not needed.
let instance: ReturnType<typeof createWorker> | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const { Indexer } = await import('./indexer/index.ts')
  const runner = createCliRunner(undefined, undefined, (m) => orca.log(m))
  instance = createWorker({
    createIndexer: (opts) => new Indexer(opts) as unknown as IndexerLike,
    async runCli(args, timeoutMs, cliPathSetting) {
      const cli = resolveCli(cliPathSetting, defaultFinderEnv())
      if (!cli) throw new CliError('cli_not_found', CLI_HINT)
      return runner.run(cli, args, timeoutMs)
    },
    killCli: () => runner.killAll()
  })
  await instance.activate(orca)
}

export async function deactivate(): Promise<void> {
  await instance?.deactivate()
  instance = null
}
