import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/list-response.json', import.meta.url), 'utf8'))

// Minimal stub of the contract's AV.model (the real one is written in parallel).
globalThis.AV = {
  model: {
    relTime: (ms, now) => Math.round((now - ms) / 3600000) + 'h',
    fullTime: (ms) => new Date(ms).toISOString(),
    hostOf: (u) => new URL(u).host,
    versionBadge: (it) => (it.publishCount > 1 ? 'v' + it.publishCount : ''),
    worktreeLabel: (cwd, wts) => {
      const w = (wts || []).find((x) => cwd.toLowerCase().startsWith(x.path.toLowerCase()))
      return w ? w.name : ''
    },
    groupBySession(items, sessions) {
      const by = new Map()
      for (const it of items) {
        const sid = it.versions[it.versions.length - 1].sessionId
        if (!by.has(sid)) by.set(sid, { sessionId: sid, session: sessions[sid], items: [], lastAt: 0 })
        const g = by.get(sid)
        g.items.push(it)
        g.lastAt = Math.max(g.lastAt, it.updatedAt)
      }
      return [...by.values()].sort((a, b) => b.lastAt - a.lastAt)
    }
  }
}

const cards = require('./cards.js')
const sessions = require('./sessions.js')

const now = 1795000000000
const vm = (over = {}) => ({
  items: fixture.items,
  sessions: fixture.sessions,
  pins: new Set(fixture.pins),
  context: fixture.context,
  scope: 'repo',
  now,
  selectedKey: null,
  query: '',
  kind: 'all',
  groupBy: 'date',
  ...over
})

test('registers views on AV.views', () => {
  assert.equal(globalThis.AV.views.cards.id, 'cards')
  assert.equal(globalThis.AV.views.cards.label, 'Cards')
  assert.equal(globalThis.AV.views.sessions.id, 'sessions')
  assert.equal(typeof globalThis.AV.views.sessions.render, 'function')
})

test('cards: pinned split from grid, every item once', () => {
  const l = cards.layout(vm())
  assert.deepEqual(l.pinned.map((c) => c.key), fixture.pins)
  assert.equal(l.pinned.length + l.cards.length, fixture.items.length)
  assert.ok(l.pinned.every((c) => c.pinned))
})

test('cards: every card has a generated cover; thumbUrl comes from vm.thumbUrl', () => {
  const l = cards.layout(vm())
  const all = [...l.pinned, ...l.cards]
  assert.ok(all.every((c) => c.cover.type === 'generated' && c.thumbUrl === null))
  const claude = all.find((c) => c.kind === 'claude')
  assert.equal(claude.cover.host, 'claude.ai')
  assert.equal(claude.cover.icon, 'artifact')
  assert.equal(all.find((c) => c.key === 'claude:Cnv4sDemoSlug0000000001').cover.tag, '')
  const vis = all.find((c) => c.kind === 'visual')
  assert.equal(vis.cover.icon, 'visual')
  assert.equal(vis.cover.host, 'local file')
  const l2 = cards.layout(vm({ thumbUrl: (k) => (k === vis.key ? 'data:image/jpeg;base64,AAAA' : null) }))
  const all2 = [...l2.pinned, ...l2.cards]
  assert.equal(all2.find((c) => c.key === vis.key).thumbUrl, 'data:image/jpeg;base64,AAAA')
  assert.equal(all2.filter((c) => c.thumbUrl).length, 1)
})

test('cards: type tag maps known words', () => {
  assert.equal(cards.typeTag({ kind: 'claude', artifactType: 'https://claude.ai/types/deck' }), 'Deck')
  assert.equal(cards.typeTag({ kind: 'claude', artifactType: 'https://claude.ai/types/opaque' }), '')
  assert.equal(cards.typeTag({ kind: 'visual', artifactType: 'deck' }), '')
})

test('cards: cover seed is deterministic and key-dependent', () => {
  assert.deepEqual(cards.coverSeed('a'), cards.coverSeed('a'))
  assert.notDeepEqual(cards.coverSeed('a'), cards.coverSeed('b'))
  const s = cards.coverSeed('claude:x')
  assert.ok(s.hue >= 0 && s.hue < 360 && s.hue2 >= 0 && s.hue2 < 360)
})

test('cards: meta and selection', () => {
  const l = cards.layout(vm({ selectedKey: fixture.items[0].key }))
  const c = [...l.pinned, ...l.cards].find((x) => x.key === fixture.items[0].key)
  assert.equal(c.selected, true)
  assert.equal(c.meta.version, 'v4')
  assert.equal(c.meta.worktree, 'roleplay-0.16')
})

test('cards: empty items yields empty layout', () => {
  assert.deepEqual(cards.layout(vm({ items: [] })), { pinned: [], cards: [] })
})

test('sessions: groups, headers and compact flag', () => {
  sessions.collapsed.clear()
  const l = sessions.layout(vm())
  const total = l.groups.reduce((n, g) => n + g.rows.length, 0)
  assert.equal(total, fixture.items.length)
  for (const g of l.groups) assert.equal(g.compact, g.rows.length === 1)
  const wt = l.groups.find((g) => g.sessionId === 's-wt-1')
  assert.equal(wt.title, 'Ajustes 0.16 del canvas')
  assert.equal(wt.entrypoint, 'orca')
  assert.equal(wt.branch, 'roleplay-0.16')
  assert.equal(wt.count, wt.rows.length)
})

test('sessions: untitled fallback', () => {
  const v = vm({ sessions: {} })
  const l = sessions.layout(v)
  assert.ok(l.groups.every((g) => g.title === 'Untitled session'))
})

test('sessions: version dots only for this session, latest flagged', () => {
  const l = sessions.layout(vm())
  const wt = l.groups.find((g) => g.sessionId === 's-wt-1')
  const row = wt.rows.find((r) => r.key === 'claude:Cnv4sDemoSlug0000000001')
  assert.equal(row.dots.length, 2) // 2 of 4 versions belong to s-wt-1
  assert.deepEqual(row.dots.map((d) => d.latest), [false, true])
  assert.ok(row.dots[0].label.includes('Updated'))
})

test('sessions: selected row expands history newest first with foreign session titles', () => {
  const key = 'claude:Cnv4sDemoSlug0000000001'
  const l = sessions.layout(vm({ selectedKey: key }))
  const wt = l.groups.find((g) => g.sessionId === 's-wt-1')
  const row = wt.rows.find((r) => r.key === key)
  assert.equal(row.selected, true)
  assert.equal(row.history.length, 4)
  assert.equal(row.history[0].fullTime, new Date(1794950000000).toISOString())
  assert.equal(row.history[0].session, '') // same session as group
  assert.equal(row.history[3].session, fixture.sessions['s-main-1'].title)
  assert.equal(row.history[3].actionLabel, 'Created')
  const other = wt.rows.find((r) => r.key !== key)
  assert.equal(other?.history ?? null, null)
})

test('sessions: collapsed state kept in module map, not applied to compact groups', () => {
  sessions.collapsed.clear()
  const multi = sessions.layout(vm()).groups.find((g) => !g.compact)
  const single = sessions.layout(vm()).groups.find((g) => g.compact)
  if (multi) sessions.collapsed.set(multi.sessionId, true)
  if (single) sessions.collapsed.set(single.sessionId, true)
  const l = sessions.layout(vm())
  if (multi) assert.equal(l.groups.find((g) => g.sessionId === multi.sessionId).collapsed, true)
  if (single) assert.equal(l.groups.find((g) => g.sessionId === single.sessionId).collapsed, false)
  sessions.collapsed.clear()
})
