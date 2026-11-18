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
