import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const M = require('./model.js')
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/list-response.json', import.meta.url), 'utf8'))
const items = fx.items
const byKey = (k) => items.find((i) => i.key === k)
const PINNED = 'claude:Cnv4sDemoSlug0000000001'
const keys = (list) => list.map((i) => i.key)

test('filterItems: query matches title, description, url and file name', () => {
  assert.equal(M.filterItems(items, { q: 'LOGS' }, []).length, 1)
  assert.equal(M.filterItems(items, { q: 'design canvas' }, [])[0].key, PINNED)
  assert.equal(M.filterItems(items, { q: 'claude.ai/code/artifact' }, []).length, 1)
  assert.equal(M.filterItems(items, { q: 'latency-by-region-7c1e.html' }, [])[0].kind, 'visual')
  assert.equal(M.filterItems(items, { q: 'zzz-nothing' }, []).length, 0)
  assert.equal(M.filterItems(items, { q: '  ' }, []).length, items.length)
})

test('filterItems: kind and pinsOnly', () => {
  assert.equal(M.filterItems(items, { kind: 'visual' }, []).length, 1)
  assert.equal(M.filterItems(items, { kind: 'claude' }, []).length, 3)
  assert.deepEqual(keys(M.filterItems(items, { pinsOnly: true }, new Set([PINNED]))), [PINNED])
  assert.deepEqual(keys(M.filterItems(items, { pinsOnly: true }, fx.pins)), [PINNED])
  assert.equal(M.filterItems(items, { kind: 'visual', pinsOnly: true }, fx.pins).length, 0)
})

test('groupByDate: pinned first and not repeated, empty groups dropped', () => {
  const now = fx.items[0].updatedAt + 3600000
  const g = M.groupByDate(items, now, fx.pins)
  assert.equal(g[0].id, 'pinned')
  assert.deepEqual(keys(g[0].items), [PINNED])
  const all = g.flatMap((x) => keys(x.items))
  assert.equal(all.length, items.length)
  assert.equal(new Set(all).size, items.length)
  assert.ok(g.every((x) => x.items.length > 0))
})

test('groupByDate: boundaries around local midnight and the 7 day window', () => {
  const now = new Date(2026, 10, 18, 15, 0, 0).getTime()
  const startToday = new Date(2026, 10, 18).getTime()
  const startWeek = new Date(2026, 10, 12).getTime()
  const mk = (key, updatedAt) => ({ key, updatedAt, sessionIds: [] })
  const g = M.groupByDate(
    [mk('a', startToday), mk('b', startToday - 1), mk('c', startWeek), mk('d', startWeek - 1), mk('e', now + 5000)],
    now,
    []
  )
  const by = Object.fromEntries(g.map((x) => [x.id, keys(x.items)]))
  assert.deepEqual(by.today, ['e', 'a'])
  assert.deepEqual(by.week, ['b', 'c'])
  assert.deepEqual(by.older, ['d'])
  assert.equal(by.pinned, undefined)
})

test('groupBySession: item under every session, sorted by lastAt desc', () => {
  const g = M.groupBySession(items, fx.sessions)
  assert.deepEqual(g.map((x) => x.sessionId), ['s-wt-1', 's-main-1', 's-main-2'])
  const wt = g.find((x) => x.sessionId === 's-wt-1')
  assert.deepEqual(keys(wt.items), [PINNED, 'visual:0123456789abcdef0123456789abcdef/latency-by-region-7c1e.html'])
  assert.deepEqual(keys(g.find((x) => x.sessionId === 's-main-1').items), [PINNED])
  assert.equal(wt.session.title, 'Ajustes 0.16 del canvas')
  assert.equal(wt.lastAt, fx.sessions['s-wt-1'].lastAt)
  const unknown = M.groupBySession([{ key: 'x', updatedAt: 5, sessionIds: ['ghost'] }], {})
  assert.equal(unknown[0].session, undefined)
  assert.equal(unknown[0].lastAt, 5)
})

test('relTime: buckets', () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime()
  assert.equal(M.relTime(now - 30000, now), 'now')
  assert.equal(M.relTime(now + 1000, now), 'now')
  assert.equal(M.relTime(now - 5 * 60000, now), '5m')
  assert.equal(M.relTime(now - 3 * 3600000, now), '3h')
  assert.equal(M.relTime(now - 2 * 86400000, now), '2d')
  assert.equal(M.relTime(new Date(2026, 10, 3, 9).getTime(), now), 'Nov 3')
  assert.equal(M.relTime(new Date(2025, 9, 3, 9).getTime(), now), 'Oct 3, 2025')
  assert.match(M.fullTime(new Date(2026, 10, 3, 9, 5).getTime()), /^Nov 3, 2026 09:05$/)
})

test('worktreeLabel: containing worktree, case/slash-insensitive, else basename', () => {
  const wts = fx.context.worktrees
  assert.equal(M.worktreeLabel('C:\\Users\\dev\\orca\\workspaces\\roleplay-journal\\roleplay-0.16', wts), 'roleplay-0.16')
  assert.equal(M.worktreeLabel('c:/users/dev/orca/workspaces/roleplay-journal/roleplay-0.16/src/', wts), 'roleplay-0.16')
  assert.equal(M.worktreeLabel('C:\\Users\\dev\\Development\\roleplay-journal\\web', wts), 'roleplay-journal')
  assert.equal(M.worktreeLabel('C:\\Users\\dev\\Development\\roleplay-journal-other', wts), 'roleplay-journal-other')
  assert.equal(M.worktreeLabel('D:\\elsewhere\\proj\\', []), 'proj')
})

test('versionBadge, kindLabel, hostOf, fileName', () => {
  assert.equal(M.versionBadge({ publishCount: 1 }), '')
  assert.equal(M.versionBadge({ publishCount: 0 }), '')
  assert.equal(M.versionBadge(byKey(PINNED)), 'v4')
  assert.equal(M.kindLabel('claude'), 'Artifact')
  assert.equal(M.kindLabel('visual'), 'Visual')
  assert.equal(M.hostOf('https://claude.ai/artifact/abc?x=1'), 'claude.ai')
  assert.equal(M.hostOf('https://user@example.com:8443/p'), 'example.com')
  assert.equal(M.hostOf('not a url'), '')
  assert.equal(M.fileName('C:\\a\\b\\c.html'), 'c.html')
  assert.equal(M.fileName('/a/b/c.html'), 'c.html')
  assert.equal(M.fileName(undefined), '')
})

test('isClaudeArtifactUrl: only https claude.ai artifact links', () => {
  assert.equal(M.isClaudeArtifactUrl('https://claude.ai/artifact/abc'), true)
  assert.equal(M.isClaudeArtifactUrl('https://claude.ai/code/artifact/uuid'), true)
  assert.equal(M.isClaudeArtifactUrl('https://evil.example/claude.ai/artifact/X'), false)
  assert.equal(M.isClaudeArtifactUrl('https://notclaude.ai/artifact/X'), false)
  assert.equal(M.isClaudeArtifactUrl('https://claude.ai.evil.example/artifact/X'), false)
  assert.equal(M.isClaudeArtifactUrl('http://claude.ai/artifact/X'), false)
  assert.equal(M.isClaudeArtifactUrl('file:///x'), false)
  assert.equal(M.isClaudeArtifactUrl(undefined), false)
})

test('panelState: render decision', () => {
  const ctx = { worktreePath: '/w' }
  const base = { query: '', kind: 'all', pinsOnly: false, loading: false, requestError: '' }
  assert.equal(M.panelState({ ...base, data: null, loading: true }).state, 'skeleton')
  const err = M.panelState({ ...base, data: null, requestError: 'boom' })
  assert.deepEqual(err, { state: 'error', message: 'boom' })
  assert.equal(M.panelState({ ...base, data: { context: {}, items: [], pins: [], error: 'no ws' } }).state, 'no-workspace')
  assert.equal(M.panelState({ ...base, data: { context: ctx, items: [], pins: [], indexing: true } }).state, 'skeleton')
  assert.equal(M.panelState({ ...base, data: { context: ctx, items: [], pins: [] } }).state, 'empty-index')
  const data = { context: ctx, items, pins: fx.pins }
  assert.equal(M.panelState({ ...base, data }).state, 'items')
  assert.equal(M.panelState({ ...base, data, query: 'zzz-nothing' }).state, 'no-results')
  assert.equal(M.panelState({ ...base, data, kind: 'visual', pinsOnly: true }).state, 'no-results')
})

test('coverCropRect: whole image, cover + top-anchored', () => {
  // wide image -> trim sides, centered
  assert.deepEqual(M.coverCropRect(1000, 300, null, 480, 300), { sx: 260, sy: 0, sw: 480, sh: 300 })
  // tall image -> keep full width, take the top slice
  assert.deepEqual(M.coverCropRect(480, 1000, null, 480, 300), { sx: 0, sy: 0, sw: 480, sh: 300 })
  assert.deepEqual(M.coverCropRect(960, 1200, null, 480, 300), { sx: 0, sy: 0, sw: 960, sh: 600 })
})

test('coverCropRect: crop rect is honored and clamped', () => {
  assert.deepEqual(M.coverCropRect(2000, 1500, { x: 0, y: 45, w: 1600, h: 1000 }, 480, 300), { sx: 0, sy: 45, sw: 1600, sh: 1000 })
  const r = M.coverCropRect(1000, 800, { x: 900, y: 700, w: 500, h: 500 }, 480, 300)
  assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 1000 && r.sy + r.sh <= 800)
  assert.deepEqual(M.coverCropRect(800, 600, { x: 0, y: 0, w: 0, h: 0 }, 480, 300), M.coverCropRect(800, 600, null, 480, 300))
})

test('thumbNeeded: claude only with item.thumb differing from the asked rev', () => {
  const c = { kind: 'claude' }
  assert.equal(M.thumbNeeded(c, undefined), false)
  assert.equal(M.thumbNeeded({ kind: 'claude', thumb: 'r1' }, undefined), true)
  assert.equal(M.thumbNeeded({ kind: 'claude', thumb: 'r1' }, { want: 'r1', state: 'ready' }), false)
  assert.equal(M.thumbNeeded({ kind: 'claude', thumb: 'r1' }, { want: 'r1', state: 'none' }), false)
  assert.equal(M.thumbNeeded({ kind: 'claude', thumb: 'r2' }, { want: 'r1', state: 'ready' }), true)
  assert.equal(M.thumbNeeded(null, undefined), false)
})

test('thumbNeeded: visual asks once, then again when a thumb appears', () => {
  const v = { kind: 'visual' }
  assert.equal(M.thumbNeeded(v, undefined), true)
  assert.equal(M.thumbNeeded(v, { want: null, state: 'capturing' }), false)
  assert.equal(M.thumbNeeded(v, { want: null, state: 'none' }), false)
  assert.equal(M.thumbNeeded({ kind: 'visual', thumb: 'm-1' }, { want: null, state: 'capturing' }), true)
  assert.equal(M.thumbNeeded({ kind: 'visual', thumb: 'm-1' }, { want: 'm-1', state: 'ready' }), false)
})

test('dataUrlBytes approximates decoded size', () => {
  assert.equal(M.dataUrlBytes('data:image/jpeg;base64,AAAA'), 3)
  assert.equal(M.dataUrlBytes('nope'), 0)
})

// ---- thumb queue ----
function mkQueue(over = {}) {
  const t = { now: 1000 }
  const calls = []
  const logs = { info: [], warn: [] }
  const changed = []
  const base = over.request || (async () => ({ kind: 'ready', rev: 'r', dataUrl: 'data:image/jpeg;base64,AA' }))
  const opts = {
    downscale: async () => 'data:image/jpeg;base64,SMALL',
    now: () => t.now,
    onChange: (k) => changed.push(k),
    max: 3,
    log: { info: (...a) => logs.info.push(a), warn: (...a) => logs.warn.push(a) },
    ...over,
    request: undefined
  }
  opts.request = (method, params) => { if (method === 'artifacts.thumb') calls.push([method, params]); return base(method, params) }
  const q = M.createThumbQueue(opts)
  return { q, t, calls, logs, changed }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const flush = async () => { for (let i = 0; i < 10; i++) await tick() }

test('thumbQueue: never more than 3 in flight, drains after errors', async () => {
  let active = 0
  let peak = 0
  const { q, calls } = mkQueue({
    request: async (m, p) => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
      if (/^k[0-4]$/.test(p.key) && Number(p.key[1]) % 2 === 0) throw new Error('rate limited')
      return { kind: 'ready', rev: 'r', dataUrl: 'data:x;base64,AA' }
    }
  })
  for (let i = 0; i < 8; i++) q.want({ key: 'k' + i, kind: 'claude', thumb: 'r' })
  assert.equal(q.inFlight(), 3)
  await flush()
  assert.equal(peak, 3)
  assert.equal(q.inFlight(), 0)
  assert.equal(calls.length, 8)
  assert.equal(q.get('k0').state, 'error')
  assert.equal(q.get('k7').state, 'ready')
})

test('thumbQueue: stale response never overwrites a newer entry', async () => {
  const resolvers = []
  const { q } = mkQueue({
    request: (m, p) => new Promise((res) => resolvers.push(res))
  })
  q.want({ key: 'a', kind: 'claude', thumb: 'r1' })
  // newer rev asked while the first is still in flight is ignored (pending); settle first, then ask again
  resolvers[0]({ kind: 'ready', rev: 'r1', dataUrl: 'data:x;base64,OLD' })
  await flush()
  q.want({ key: 'a', kind: 'claude', thumb: 'r2' })
  q.clear()
  q.want({ key: 'a', kind: 'claude', thumb: 'r3' }) // new entry replaces the cleared one
  resolvers[1]({ kind: 'ready', rev: 'r2', dataUrl: 'data:x;base64,STALE' }) // belongs to the cleared entry
  await flush()
  assert.equal(q.get('a').state, 'pending')
  assert.equal(q.url('a'), null)
  resolvers[2]({ kind: 'ready', rev: 'r3', dataUrl: 'data:x;base64,NEW' })
  await flush()
  assert.equal(q.url('a'), 'data:x;base64,NEW')
  assert.equal(q.inFlight(), 0)
})

test('thumbQueue: raw shown even when thumbStore rejects or refuses', async () => {
  for (const store of [() => Promise.reject(new Error('boom')), () => Promise.resolve({ ok: false, reason: 'too big' })]) {
    const { q, logs } = mkQueue({
      request: async (m) => (m === 'artifacts.thumb' ? { kind: 'raw', rev: 'r', dataUrl: 'data:image/png;base64,RAW' } : store())
    })
    q.want({ key: 'a', kind: 'claude', thumb: 'r' })
    await flush()
    assert.equal(q.url('a'), 'data:image/jpeg;base64,SMALL')
    assert.equal(q.get('a').state, 'ready')
    assert.equal(logs.warn.length, 1)
    assert.match(String(logs.warn[0][0]), /thumbStore/)
  }
})

test('thumbQueue: downscale failure is logged, counter decrements, state error', async () => {
  const { q, logs } = mkQueue({
    request: async () => ({ kind: 'raw', rev: 'r', dataUrl: 'data:x;base64,A' }),
    downscale: async () => { throw new Error('decode') }
  })
  q.want({ key: 'a', kind: 'claude', thumb: 'r' })
  await flush()
  assert.equal(q.inFlight(), 0)
  assert.equal(q.get('a').state, 'error')
  assert.equal(logs.warn.length, 1)
})

test('thumbQueue: capturing re-asks after a newer list or after 60 s', async () => {
  const { q, t, calls } = mkQueue({ request: async () => ({ kind: 'capturing' }) })
  const item = { key: 'v', kind: 'visual' }
  assert.equal(q.want(item), true)
  await flush()
  assert.equal(q.get('v').state, 'capturing')
  assert.equal(q.want(item), false)
  q.bumpList()
  assert.equal(q.want(item), true)
  await flush()
  assert.equal(q.want(item), false)
  t.now += 61000
  assert.equal(q.want(item), true)
  assert.equal(calls.length, 3)
})

test('thumbQueue: transient error retried after 30 s, max 3 attempts per rev', async () => {
  const { q, t, calls } = mkQueue({ request: async () => { throw new Error('rate limit') } })
  const item = { key: 'a', kind: 'claude', thumb: 'r1' }
  q.want(item)
  await flush()
  assert.equal(q.get('a').state, 'error')
  t.now += 29000
  assert.equal(q.want(item), false)
  t.now += 1000
  assert.equal(q.want(item), true)
  await flush()
  t.now += 30000
  assert.equal(q.want(item), true)
  await flush()
  t.now += 600000
  assert.equal(q.want(item), false) // 3 attempts used
  assert.equal(calls.length, 3)
  // a new rev resets the budget
  assert.equal(q.want({ key: 'a', kind: 'claude', thumb: 'r2' }), true)
})

test('thumbQueue: visual stale-rev flow', async () => {
  const answers = [
    { kind: 'ready', rev: 'old', dataUrl: 'data:x;base64,OLD' },
    { kind: 'ready', rev: 'new', dataUrl: 'data:x;base64,NEW' }
  ]
  const { q, changed } = mkQueue({ request: async () => answers.shift() })
  assert.equal(q.want({ key: 'v', kind: 'visual', thumb: 'old' }), true)
  await flush()
  assert.equal(q.url('v'), 'data:x;base64,OLD')
  assert.equal(q.want({ key: 'v', kind: 'visual', thumb: 'old' }), false)
  assert.equal(q.want({ key: 'v', kind: 'visual', thumb: 'new' }), true)
  await flush()
  assert.equal(q.url('v'), 'data:x;base64,NEW')
  assert.deepEqual(changed, ['v', 'v'])
  // a visual that previously had a thumb and lost it asks again
  assert.equal(q.want({ key: 'v', kind: 'visual' }), true)
})

test('thumbQueue: none keeps its reason, logged once per distinct reason', async () => {
  const { q, logs } = mkQueue({ request: async (m, p) => ({ kind: 'none', reason: p.key === 'c' ? 'other' : 'no browser' }) })
  for (const k of ['a', 'b', 'c']) q.want({ key: k, kind: 'visual' })
  await flush()
  assert.equal(q.reason('a'), 'no browser')
  assert.equal(q.reason('c'), 'other')
  assert.equal(logs.info.length, 2)
  assert.equal(q.want({ key: 'a', kind: 'visual' }), false)
})

test('ioFallbackDue: only when no observer callback fired and still mounted', () => {
  assert.equal(M.ioFallbackDue(false, true), true)
  assert.equal(M.ioFallbackDue(true, true), false)
  assert.equal(M.ioFallbackDue(false, false), false)
  assert.equal(M.IO_FALLBACK_MS, 1500)
})
