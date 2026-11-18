import { test, assert, mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createWorker, type IndexerLike, type IndexerOpts } from './worker.ts'
import { CliError } from './cli.ts'
import type { PathsEnv } from './paths.ts'
import type { Item } from './types.ts'

const rows = [
  { id: 'w1', kind: 'worktree', name: 'main', projectId: 'p1', path: 'C:/dev/app', branch: 'refs/heads/main', hostId: 'local' },
  { id: 'w2', kind: 'worktree', name: 'feat', projectId: 'p1', path: 'C:/wt/feat', branch: 'refs/heads/feat', hostId: 'local' }
]

const item = (key: string, url: string): Item => ({
  key, kind: 'claude', url, title: key, firstSeenAt: 1, updatedAt: 2, publishCount: 1, versions: [], sessionIds: [], lastCwd: 'C:/dev/app'
})

type ScanResult = { failed?: number; cacheWriteError?: string }

function fakeIndexer() {
  const state = {
    scans: [] as { roots: string[]; finish(changed?: boolean, extra?: ScanResult): void; fail(e: Error): void; signal?: AbortSignal }[],
    rev: 1,
    cleared: 0,
    items: [item('claude:a', 'https://claude.ai/code/artifact/a'), item('visual:c/x.html', 'file:///C:/x.html')]
  }
  const indexer: IndexerLike = {
    async load() {},
    scan(roots, signal) {
      return new Promise((resolve, reject) => {
        state.scans.push({
          roots,
          signal,
          finish: (changed = true, extra = {}) => {
            if (changed) state.rev++
            resolve({ changed, filesRead: 1, ...extra })
          },
          fail: reject
        })
      })
    },
    query: () => ({ items: state.items, sessions: {} }),
    async clear() {
      state.cleared++
    },
    get rev() {
      return state.rev
    },
    get lastIndexedAt() {
      return null
    }
  }
  return { indexer, state }
}

type SetupOpts = {
  runCli?: (args: string[]) => Promise<unknown>
  ctx?: unknown
  settings?: Record<string, string>
  /** Projects folders that exist (default: ~/.claude/projects). */
  existing?: string[]
  query?: IndexerLike['query']
  /** Extra host method overrides. */
  results?: Record<string, unknown>
}

async function setup(opts: SetupOpts = {}) {
  const fx = fakeIndexer()
  if (opts.query) fx.indexer.query = opts.query
  const cliCalls: { args: string[]; timeout: number; cliPath?: string }[] = []
  const created: IndexerOpts[] = []
  const existing = new Set<string>(opts.existing ?? ['/home/u/.claude/projects'])
  const pathsEnv: PathsEnv = {
    home: '/home/u',
    platform: 'linux',
    env: {},
    exists: (p) => existing.has(p),
    readText: () => null
  }
  let killed = 0
  const w = createWorker({
    createIndexer: (o) => {
      created.push(o)
      return fx.indexer
    },
    runCli: async (args, timeout, cliPath) => {
      cliCalls.push({ args, timeout, cliPath })
      return opts.runCli ? opts.runCli(args) : {}
    },
    killCli: () => void killed++,
    config: { throttleMs: 20, debounceMs: 30, staleMs: 60_000 },
    pathsEnv
  })
  const host = mockHost({
    results: {
      'workspace.readContext': opts.ctx === undefined ? { workspaceId: 'w1', branch: 'main', displayName: 'main', terminals: [] } : opts.ctx,
      'workspace.list': { workspaces: rows, truncated: false },
      ...opts.results
    },
    settings: opts.settings
  })
  let orca!: OrcaWorkerApi
  const worker = await mountWorker(
    {
      default: (o: OrcaWorkerApi) => {
        orca = o
        return w.activate(o)
      },
      deactivate: w.deactivate
    },
    { host }
  )
  return { fx, cliCalls, worker, host, w, orca, created, existing, killed: () => killed }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await sleep(5)
  }
}

type Post = { event: string; payload?: unknown }
const lastIndexing = (posts: readonly Post[]): boolean | undefined =>
  (posts[posts.length - 1]?.payload as { indexing?: boolean } | undefined)?.indexing
const idle = (posts: readonly Post[]) => () => lastIndexing(posts) === false

test('list answers at once while the scan is pending, then posts changed', async () => {
  const { fx, worker } = await setup()
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.indexing, true)
  assert.equal(res.items.length, 2)
  assert.deepEqual(res.context.worktrees.map((w) => w.path), ['C:/dev/app', 'C:/wt/feat'])
  assert.deepEqual(fx.state.scans[0].roots, ['C:/dev/app', 'C:/wt/feat'])
  assert.ok(worker.posts.some((p) => (p.payload as { indexing: boolean }).indexing === true)) // scan-start post
  fx.state.scans[0].finish()
  await waitFor(idle(worker.posts))
  const last = worker.posts[worker.posts.length - 1].payload as { rev: number; indexing: boolean }
  assert.equal(last.indexing, false)
  assert.equal(last.rev, 2)
  await worker.deactivate()
})

test('a second list does not start another scan while fresh', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].finish()
  await waitFor(idle(worker.posts))
  const res = await worker.request('artifacts.list', { scope: 'worktree' })
  assert.equal(res.indexing, false)
  assert.equal(fx.state.scans.length, 1)
  await worker.deactivate()
})

test('list without a focused workspace returns an error response, not a throw', async () => {
  const { worker } = await setup({ ctx: null })
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.error, 'No workspace focused')
  assert.deepEqual(res.items, [])
  await worker.deactivate()
})

test('list rejects an invalid scope', async () => {
  const { worker } = await setup()
  await assert.rejects(worker.request('artifacts.list', { scope: 'nope' } as never), /scope/)
  await worker.deactivate()
})

test('open builds the exact CLI args for the focused worktree', async () => {
  const { worker, cliCalls } = await setup()
  const r = await worker.request('artifacts.open', { key: 'claude:a' })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(cliCalls[0].args, ['tab', 'create', '--url', 'https://claude.ai/code/artifact/a', '--worktree', 'path:C:/dev/app'])
  assert.equal(cliCalls[0].timeout, 15000)
  const v = await worker.request('artifacts.open', { key: 'visual:c/x.html' })
  assert.deepEqual(v, { ok: true })
  assert.equal(cliCalls[1].args[3], 'file:///C:/x.html')
  await worker.deactivate()
})

test('open passes CLI error messages through as reasons', async () => {
  const hint = 'Orca CLI not found. Set its path in the plugin settings ("Orca CLI path").'
  const missing = await setup({ runCli: async () => { throw new CliError('cli_not_found', hint) } })
  assert.deepEqual(await missing.worker.request('artifacts.open', { key: 'claude:a' }), { ok: false, reason: hint })
  const failed = await setup({ runCli: async () => { throw new CliError('cli_failed', 'worktree not found') } })
  assert.deepEqual(await failed.worker.request('artifacts.open', { key: 'claude:a' }), { ok: false, reason: 'worktree not found' })
  const r3 = await failed.worker.request('artifacts.open', { key: 'claude:zzz' })
  assert.equal(r3.ok, false)
  assert.equal(failed.cliCalls.length, 1)
})

test('open reports a configured CLI path that does not exist, and a .cmd shim, by their own messages', async () => {
  const gone = 'Configured Orca CLI path does not exist: D:\\nope\\orca.exe'
  const a = await setup({ runCli: async () => { throw new CliError('cli_not_found', gone) } })
  assert.deepEqual(await a.worker.request('artifacts.open', { key: 'claude:a' }), { ok: false, reason: gone })
  const cmd = 'The CLI path must point to orca.exe, not a .cmd shim'
  const b = await setup({ runCli: async () => { throw new CliError('cli_invalid', cmd) } })
  assert.deepEqual(await b.worker.request('artifacts.open', { key: 'claude:a' }), { ok: false, reason: cmd })
})

test('open failure paths never call the CLI', async () => {
  const none = await setup({ ctx: null })
  const r1 = await none.worker.request('artifacts.open', { key: 'claude:a' })
  assert.deepEqual(r1, { ok: false, reason: 'No workspace focused' })
  assert.equal(none.cliCalls.length, 0)

  const unmatched = await setup({ ctx: { workspaceId: 'zzz', branch: 'nope', displayName: 'nope', terminals: [] } })
  const r2 = await unmatched.worker.request('artifacts.open', { key: 'claude:a' })
  assert.equal(r2.ok, false)
  assert.match(r2.reason ?? '', /match/)
  assert.equal(unmatched.cliCalls.length, 0)

  const bad = await setup()
  bad.fx.state.items.push(item('claude:evil', 'https://evil.example/artifact/x'), item('claude:js', 'javascript:alert(1)'))
  for (const key of ['claude:evil', 'claude:js']) {
    const r = await bad.worker.request('artifacts.open', { key })
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /Refusing/)
  }
  assert.equal(bad.cliCalls.length, 0)

  const broken = await setup({ query: () => { throw new Error('index exploded') } })
  const r4 = await broken.worker.request('artifacts.open', { key: 'claude:a' })
  assert.equal(r4.ok, false)
  assert.match(r4.reason ?? '', /index exploded/)
  assert.equal(broken.cliCalls.length, 0)
})

test('pin persists in storage, is capped, and shows in list', async () => {
  const { worker, host } = await setup()
  assert.deepEqual(await worker.request('artifacts.pin', { key: 'claude:a', pinned: true }), { pins: ['claude:a'] })
  assert.deepEqual(await worker.request('artifacts.pin', { key: 'claude:b', pinned: true }), { pins: ['claude:a', 'claude:b'] })
  assert.deepEqual(host.data().storage.pins, ['claude:a', 'claude:b'])
  assert.deepEqual((await worker.request('artifacts.list', { scope: 'repo' })).pins, ['claude:a', 'claude:b'])
  assert.deepEqual(await worker.request('artifacts.pin', { key: 'claude:a', pinned: false }), { pins: ['claude:b'] })
  for (let i = 0; i < 510; i++) await worker.request('artifacts.pin', { key: `k${i}`, pinned: true })
  assert.equal((host.data().storage.pins as string[]).length, 500)
  await worker.deactivate()
})

test('concurrent pins both persist', async () => {
  const { worker, host } = await setup()
  const out = await Promise.all([
    worker.request('artifacts.pin', { key: 'claude:a', pinned: true }),
    worker.request('artifacts.pin', { key: 'claude:b', pinned: true }),
    worker.request('artifacts.pin', { key: 'claude:c', pinned: true })
  ])
  assert.deepEqual(out[2], { pins: ['claude:a', 'claude:b', 'claude:c'] })
  assert.deepEqual(host.data().storage.pins, ['claude:a', 'claude:b', 'claude:c'])
  await worker.deactivate()
})

test('a pin whose storage read fails rejects and keeps the stored pins; list flags the read error', async () => {
  const mem: Record<string, unknown> = { pins: ['claude:a'] }
  let failReads = true
  const { worker } = await setup({
    results: {
      'storage.get': (p: { key: string }) => {
        if (failReads) throw new Error('storage down')
        return { value: mem[p.key] ?? null }
      },
      'storage.set': (p: { key: string; value: unknown }) => {
        mem[p.key] = p.value
        return { ok: true }
      }
    }
  })
  await assert.rejects(worker.request('artifacts.pin', { key: 'claude:b', pinned: true }), /storage down/)
  assert.deepEqual(mem.pins, ['claude:a'])
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.deepEqual(res.pins, [])
  assert.equal(res.error, 'Could not read pins')
  failReads = false
  // the failed pin did not poison the queue
  assert.deepEqual(await worker.request('artifacts.pin', { key: 'claude:b', pinned: true }), { pins: ['claude:a', 'claude:b'] })
  await worker.deactivate()
})

test('refresh full clears the index and starts a scan; second refresh reports not started', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].finish()
  await waitFor(idle(worker.posts))
  assert.deepEqual(await worker.request('artifacts.refresh', { full: true }), { started: true })
  assert.equal(fx.state.cleared, 1)
  assert.equal(fx.state.scans.length, 2)
  assert.deepEqual(await worker.request('artifacts.refresh', {}), { started: false })
  await worker.deactivate()
})

test('refresh explains why it cannot start', async () => {
  const none = await setup({ ctx: null })
  assert.deepEqual(await none.worker.request('artifacts.refresh', {}), { started: false, reason: 'No workspace focused' })
  const unmatched = await setup({ ctx: { workspaceId: 'zzz', branch: 'nope', displayName: 'nope', terminals: [] } })
  const r = await unmatched.worker.request('artifacts.refresh', {})
  assert.equal(r.started, false)
  assert.match(r.reason ?? '', /match/)
  assert.equal(unmatched.fx.state.scans.length, 0)
})

test('refresh full during an in-flight scan: the late old scan neither clobbers state nor posts idle', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  const old = fx.state.scans[0]
  assert.deepEqual(await worker.request('artifacts.refresh', { full: true }), { started: true })
  assert.equal(old.signal?.aborted, true)
  assert.equal(fx.state.scans.length, 2)
  // the old scan settles late, with an error and with a "failed" count: both must be ignored
  old.finish(true, { failed: 3 })
  await sleep(60) // negative assertion: give the late settle time to misbehave
  assert.equal(lastIndexing(worker.posts), true)
  let res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.indexing, true)
  assert.equal(res.error, undefined)
  // the new scan completes normally
  fx.state.scans[1].finish(true)
  await waitFor(idle(worker.posts))
  res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.indexing, false)
  assert.equal(res.error, undefined)
  await worker.deactivate()
})

test('a late old scan failure after refresh full is not surfaced', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  const old = fx.state.scans[0]
  await worker.request('artifacts.refresh', { full: true })
  old.fail(new Error('old boom'))
  await sleep(40) // negative assertion
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.error, undefined)
  assert.equal(res.indexing, true)
  await worker.deactivate()
})

test('a root that arrives while a scan runs is scanned next', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'worktree' })
  assert.deepEqual(fx.state.scans[0].roots, ['C:/dev/app'])
  await worker.request('artifacts.list', { scope: 'repo' }) // adds C:/wt/feat while scan 0 runs
  assert.equal(fx.state.scans.length, 1)
  fx.state.scans[0].finish()
  await waitFor(() => fx.state.scans.length === 2)
  assert.deepEqual(fx.state.scans[1].roots, ['C:/dev/app', 'C:/wt/feat'])
  fx.state.scans[1].finish(false)
  await waitFor(idle(worker.posts))
  assert.equal(fx.state.scans.length, 2)
  await worker.deactivate()
})

test('agent done is debounced into one scan; working is ignored; workspace.changed posts', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].finish()
  await waitFor(idle(worker.posts))
  const base = { workspaceId: 'w1', paneKey: 'p', receivedAt: 1 }
  await worker.emit('agent.status.changed', { ...base, state: 'working' })
  await sleep(60) // negative assertion: nothing may start
  assert.equal(fx.state.scans.length, 1)
  await worker.emit('agent.status.changed', { ...base, state: 'done' })
  await worker.emit('agent.status.changed', { ...base, state: 'waiting' })
  await waitFor(() => fx.state.scans.length === 2)
  await sleep(60) // negative assertion: the two events coalesced into one scan
  assert.equal(fx.state.scans.length, 2)
  fx.state.scans[1].finish(false)
  await waitFor(idle(worker.posts))
  const before = worker.posts.length
  await worker.emit('workspace.changed', { context: null })
  await waitFor(() => worker.posts.length > before)
  await worker.deactivate()
})

test('deactivate aborts the scan and kills CLI children', async () => {
  const { fx, worker, killed } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  await worker.deactivate()
  assert.equal(fx.state.scans[0].signal?.aborted, true)
  assert.equal(killed(), 1)
})

test('a failed scan surfaces as an error on the next list, and a clean scan clears it', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].fail(new Error('disk full'))
  await waitFor(idle(worker.posts))
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.match(res.error ?? '', /disk full/)
  await worker.request('artifacts.refresh', {})
  fx.state.scans[1].finish()
  await waitFor(idle(worker.posts))
  assert.equal((await worker.request('artifacts.list', { scope: 'repo' })).error, undefined)
  await worker.deactivate()
})

test('unreadable transcripts and cache write failures surface as errors; refresh full clears them', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].finish(true, { failed: 2 })
  await waitFor(idle(worker.posts))
  let res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.match(res.error ?? '', /Could not read 2 transcript file\(s\)/)
  assert.match(res.error ?? '', /orca plugin logs/)

  await worker.request('artifacts.refresh', { full: true })
  res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.error, undefined) // cleared by refresh(full) before the new scan reports
  fx.state.scans[1].finish(true, { failed: 1, cacheWriteError: 'EACCES' })
  await waitFor(idle(worker.posts))
  res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.match(res.error ?? '', /Could not read 1 transcript file\(s\).*index cache could not be saved/)
  await worker.deactivate()
})

test('a cache write failure alone is reported', async () => {
  const { fx, worker } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  fx.state.scans[0].finish(false, { cacheWriteError: 'EACCES' })
  await waitFor(idle(worker.posts))
  const res = await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(res.error, 'Index cache could not be saved')
  await worker.deactivate()
})

test('no projects folder yields an actionable error naming the configured folders', async () => {
  const auto = await setup({ existing: [] })
  const r1 = await auto.worker.request('artifacts.list', { scope: 'repo' })
  assert.match(r1.error ?? '', /No Claude projects folder found \(looked in: \/home\/u\/\.claude\/projects\)/)
  assert.match(r1.error ?? '', /Claude config folders/)
  const configured = await setup({ existing: [], settings: { claudeDirs: '/nope\n/also-missing' } })
  const r2 = await configured.worker.request('artifacts.list', { scope: 'repo' })
  assert.match(r2.error ?? '', /\/nope\/projects/)
  assert.match(r2.error ?? '', /not found: .*\/also-missing\/projects/)
})

test('projects dirs are recomputed at scan time; the indexer is rebuilt only when the set changed', async () => {
  const { fx, worker, created, existing } = await setup({
    settings: { claudeDirs: '/a\n/b' },
    existing: ['/a/projects']
  })
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].projectsDirs, ['/a/projects'])
  await worker.request('artifacts.list', { scope: 'repo' })
  assert.equal(created.length, 1) // same dir set: no rebuild
  fx.state.scans[0].finish()
  await waitFor(idle(worker.posts))
  existing.add('/b/projects')
  await worker.request('artifacts.refresh', { full: true })
  assert.equal(created.length, 2)
  assert.deepEqual(created[1].projectsDirs, ['/a/projects', '/b/projects'])
  await worker.deactivate()
})

test('changing claudeDirs rebuilds the indexer and aborts the scan; changing cliPath does not', async () => {
  const { fx, worker, created, orca, cliCalls } = await setup()
  await worker.request('artifacts.list', { scope: 'repo' })
  await orca.settings.set('cliPath', 'D:\\x\\orca.exe')
  await sleep(40) // negative assertion: settle time for the change handler
  assert.equal(created.length, 1)
  assert.equal(fx.state.scans[0].signal?.aborted, false)
  await worker.request('artifacts.open', { key: 'claude:a' })
  assert.equal(cliCalls[0].cliPath, 'D:\\x\\orca.exe')

  await orca.settings.set('claudeDirs', '/home/u/.claude')
  await waitFor(() => created.length === 2)
  assert.equal(fx.state.scans[0].signal?.aborted, true)
  await worker.deactivate()
})
