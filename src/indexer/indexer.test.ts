import { test, assert } from 'orca/testing'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Indexer } from './index.ts'
import { encodeProjectDir } from './encode.ts'
import { parseDirectives } from './parse.ts'

const ROOT = 'C:\\work\\demo'
const SID = 'sess-1'
const CHAT = '0123456789abcdef0123456789abcdef'

type Ctx = { tmp: string; projects: string; dir: string; cache: string; logs: string[]; ix: Indexer; scratch: string }

function mk(root = ROOT): Ctx {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ixtest-'))
  const projects = path.join(tmp, 'projects')
  const dir = path.join(projects, encodeProjectDir(root))
  fs.mkdirSync(dir, { recursive: true })
  const scratch = path.join(tmp, 'orca', 'chat-scratch', CHAT)
  fs.mkdirSync(scratch, { recursive: true })
  const cache = path.join(tmp, 'cache', 'index.json')
  const logs: string[] = []
  const ix = new Indexer({ cacheFile: cache, projectsDirs: [projects], log: (m) => logs.push(m) })
  return { tmp, projects, dir, cache, logs, ix, scratch }
}

let n = 0
function base(type: string, extra: Record<string, unknown>, o: { sid?: string; cwd?: string; at?: string; sidechain?: boolean } = {}) {
  return {
    parentUuid: null,
    isSidechain: o.sidechain ?? false,
    type,
    uuid: `uuid-${++n}`,
    timestamp: o.at ?? '2026-01-02T10:00:00.000Z',
    entrypoint: 'orca',
    cwd: o.cwd ?? ROOT,
    sessionId: o.sid ?? SID,
    gitBranch: 'main',
    ...extra
  }
}
const toolUse = (id: string, input: Record<string, unknown>, o = {}) =>
  base('assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] } }, o)
const result = (id: string, tur: unknown, o: { isError?: boolean; at?: string; cwd?: string; sid?: string } = {}) =>
  base(
    'user',
    {
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'x', ...(o.isError ? { is_error: true } : {}) }] },
      toolUseResult: tur
    },
    o
  )
const text = (t: string, o = {}) => base('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: t }] } }, o)
const scratchAtt = (dir: string, o = {}) =>
  base('attachment', { attachment: { type: 'environment', snapshot: { additionalWorkingDirectories: ['C:\\x\\agent-session-attachments', dir] } } }, o)
const pub = (slug: string, extra: Record<string, unknown> = {}) => ({ url: `https://claude.ai/artifact/${slug}`, title: `T ${slug}`, version: `v-${slug}`, ...extra })

const jl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const write = (c: Ctx, name: string, lines: unknown[]) => fs.writeFileSync(path.join(c.dir, name), jl(lines))
const append = (c: Ctx, name: string, lines: unknown[]) => fs.appendFileSync(path.join(c.dir, name), jl(lines))
const cleanup = (c: Ctx) => fs.rmSync(c.tmp, { recursive: true, force: true })

test('pairs a publish across two incremental reads (pending persists)', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', { description: 'My desc', icon: 'x' }, { at: '2026-01-02T10:00:00.000Z' })])
    const r1 = await c.ix.scan([ROOT])
    assert.equal(r1.filesRead, 1)
    assert.equal(c.ix.query([ROOT]).items.length, 0)
    append(c, 's.jsonl', [result('t1', pub('AbC_1', { type: { url: 'https://claude.ai/artifact-types/deck' } }), { at: '2026-01-02T10:00:05.000Z' })])
    const r2 = await c.ix.scan([ROOT])
    assert.ok(r2.changed)
    const { items, sessions } = c.ix.query([ROOT])
    assert.equal(items.length, 1)
    const it = items[0]!
    assert.equal(it.key, 'claude:AbC_1')
    assert.equal(it.kind, 'claude')
    assert.equal(it.title, 'T AbC_1')
    assert.equal(it.description, 'My desc')
    assert.equal(it.artifactType, 'https://claude.ai/artifact-types/deck')
    assert.equal(it.versions[0]!.action, 'create')
    assert.equal(it.versions[0]!.version, 'v-AbC_1')
    assert.equal(it.updatedAt, Date.parse('2026-01-02T10:00:05.000Z'))
    assert.equal(sessions[SID]!.cwd, ROOT)
    assert.equal(sessions[SID]!.entrypoint, 'orca')
    assert.equal(sessions[SID]!.gitBranch, 'main')
    assert.ok(sessions[SID]!.transcriptPath.endsWith('s.jsonl'))
    // third scan with nothing new reads nothing
    const r3 = await c.ix.scan([ROOT])
    assert.equal(r3.filesRead, 0)
    assert.equal(r3.changed, false)
  } finally {
    cleanup(c)
  }
})

test('partial trailing line is not consumed until completed', async () => {
  const c = mk()
  try {
    const l1 = JSON.stringify(toolUse('t1', {}))
    const l2 = JSON.stringify(result('t1', pub('Slug1')))
    fs.writeFileSync(path.join(c.dir, 's.jsonl'), l1 + '\n' + l2.slice(0, 40))
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 0)
    fs.appendFileSync(path.join(c.dir, 's.jsonl'), l2.slice(40) + '\n')
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 1)
  } finally {
    cleanup(c)
  }
})

test('is_error results, api-request-blob, list/read results and asset uploads are ignored', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [
      toolUse('e1', {}),
      result('e1', pub('ErrSlug'), { isError: true }),
      toolUse('l1', { action: 'list' }),
      result('l1', { artifacts: [{ title: 'x', url: 'https://claude.ai/artifact/ListSlug' }] }),
      toolUse('r1', { action: 'read', url: 'https://claude.ai/artifact/ReadSlug' }),
      result('r1', pub('ReadSlug')),
      toolUse('a1', { action: 'publish', asset: true, url: 'https://claude.ai/artifact/AssetSlug', file_path: 'x.png' }),
      result('a1', pub('AssetSlug')),
      { type: 'api-request-blob', sessionId: SID, blob: '"name":"Artifact" toolUseResult https://claude.ai/artifact/BlobSlug' },
      toolUse('ok1', {}),
      result('ok1', pub('GoodSlug'))
    ])
    await c.ix.scan([ROOT])
    const keys = c.ix.query([ROOT]).items.map((i) => i.key)
    assert.deepEqual(keys, ['claude:GoodSlug'])
  } finally {
    cleanup(c)
  }
})

test('update action, title fallback chain, created-from-type shapes', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [
      toolUse('c1', {}, { at: '2026-01-02T10:00:00.000Z' }),
      result('c1', { url: 'https://claude.ai/artifact/S1' }, { at: '2026-01-02T10:00:01.000Z' }),
      toolUse('c2', { url: 'https://claude.ai/artifact/S1', title: 'Input title' }, { at: '2026-01-02T11:00:00.000Z' }),
      result('c2', { url: 'https://claude.ai/code/artifact/S1', version: 'v2' }, { at: '2026-01-02T11:00:01.000Z' }),
      toolUse('c3', { description: 'Only desc' }),
      result('c3', { url: 'https://claude.ai/artifact/S2', created_from_type: { url: 'https://claude.ai/types/doc' }, type: { url: 'https://claude.ai/types/slides' } }),
      toolUse('c4', { action: 'publish', title: 'Typed' }),
      result('c4', { url: 'https://claude.ai/artifact/S3', created_from_type: 'https://claude.ai/types/doc' })
    ])
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    const by = Object.fromEntries(items.map((i) => [i.key, i]))
    assert.equal(by['claude:S1']!.title, 'Input title')
    assert.equal(by['claude:S1']!.publishCount, 2)
    assert.deepEqual(by['claude:S1']!.versions.map((v) => v.action), ['create', 'update'])
    assert.equal(by['claude:S1']!.versions[1]!.version, 'v2')
    assert.equal(by['claude:S2']!.title, 'Only desc')
    assert.equal(by['claude:S2']!.artifactType, 'https://claude.ai/types/slides')
    assert.equal(by['claude:S3']!.title, 'Typed')
    assert.equal(by['claude:S3']!.artifactType, 'https://claude.ai/types/doc')
  } finally {
    cleanup(c)
  }
})

test('replayed tool_use ids across files are deduped', async () => {
  const c = mk()
  try {
    const lines = [toolUse('dup1', {}), result('dup1', pub('Dup'))]
    write(c, 'a.jsonl', lines)
    write(c, 'b.jsonl', lines)
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    assert.equal(items.length, 1)
    assert.equal(items[0]!.publishCount, 1)
    assert.equal(items[0]!.versions.length, 1)
  } finally {
    cleanup(c)
  }
})

test('versions are capped at MAX_VERSIONS keeping the newest; publishCount counts all', async () => {
  const c = mk()
  try {
    const lines: unknown[] = []
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.UTC(2026, 0, 2, 10, i)).toISOString()
      lines.push(toolUse(`m${i}`, i ? { url: 'https://claude.ai/artifact/Cap' } : {}, { at }), result(`m${i}`, pub('Cap', { version: `ver${i}` }), { at }))
    }
    write(c, 's.jsonl', lines)
    await c.ix.scan([ROOT])
    const it = c.ix.query([ROOT]).items[0]!
    assert.equal(it.publishCount, 60)
    assert.equal(it.versions.length, 50)
    assert.equal(it.versions[49]!.version, 'ver59')
    assert.equal(it.versions[0]!.version, 'ver10')
  } finally {
    cleanup(c)
  }
})

test('visual directive: only assistant text counts, not fences/inline code/thinking/tool_result/sidechain', async () => {
  const c = mk()
  try {
    for (const f of ['ok.html', 'fenced.html', 'think.html', 'tr.html', 'side.html', 'inline.html']) fs.writeFileSync(path.join(c.scratch, f), '<p>x</p>')
    const mkLine = (content: unknown[], o = {}) => base('assistant', { message: { role: 'assistant', content } }, o)
    write(c, 's.jsonl', [
      scratchAtt(c.scratch),
      text('Here you go\n::orca-visual{file="ok.html" title="Nice chart"}\nbye'),
      text('Example:\n```\n::orca-visual{file="fenced.html"}\n```\n'),
      text('Use `::orca-visual{file="inline.html"}` like so'),
      mkLine([{ type: 'thinking', thinking: '::orca-visual{file="think.html"}' }]),
      base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'zzz', content: '::orca-visual{file="tr.html"}' }] } }),
      mkLine([{ type: 'text', text: '::orca-visual{file="side.html"}' }], { sidechain: true })
    ])
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    assert.equal(items.length, 1)
    const it = items[0]!
    assert.equal(it.key, `visual:${CHAT}/ok.html`)
    assert.equal(it.kind, 'visual')
    assert.equal(it.title, 'Nice chart')
    assert.equal(it.filePath, path.join(c.scratch, 'ok.html'))
    assert.equal(it.url, pathToFileURL(path.join(c.scratch, 'ok.html')).href)
  } finally {
    cleanup(c)
  }
})

test('visual: title defaults to file name; pending until the scratch dir appears; missing file dropped', async () => {
  const c = mk()
  try {
    fs.writeFileSync(path.join(c.scratch, 'late.html'), '<p/>')
    write(c, 's.jsonl', [text('::orca-visual{file="late.html"}\n::orca-visual{file="gone.html"}')])
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 0)
    append(c, 's.jsonl', [scratchAtt(c.scratch)])
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    assert.deepEqual(items.map((i) => i.title), ['late'])
    // a missing file shows up once it exists (existence checked at query time)
    fs.writeFileSync(path.join(c.scratch, 'gone.html'), '<p/>')
    assert.equal(c.ix.query([ROOT]).items.length, 2)
    fs.rmSync(path.join(c.scratch, 'late.html'))
    assert.equal(c.ix.query([ROOT]).items.length, 1)
  } finally {
    cleanup(c)
  }
})

test('parseDirectives validates file names', () => {
  assert.deepEqual(parseDirectives('::orca-visual{file="a-b_c.1.html"}'), [{ file: 'a-b_c.1.html', title: undefined }])
  assert.equal(parseDirectives('::orca-visual{file="../x.html"}').length, 0)
  assert.equal(parseDirectives('::orca-visual{file="x.txt"}').length, 0)
  assert.equal(parseDirectives('::orca-visual{title="x"}').length, 0)
})

test('truncated/rewritten file is reparsed from zero', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('First')), toolUse('t2', {}), result('t2', pub('Second'))])
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 2)
    write(c, 's.jsonl', [toolUse('t9', {}), result('t9', pub('Third'))])
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(c.dir, 's.jsonl'), future, future)
    await c.ix.scan([ROOT])
    assert.deepEqual(c.ix.query([ROOT]).items.map((i) => i.key), ['claude:Third'])
    assert.ok(c.logs.some((l) => l.includes('reparsing')))
  } finally {
    cleanup(c)
  }
})

test('cache: persists across instances, corrupt or old-version cache starts empty', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Cached'))])
    await c.ix.scan([ROOT])
    assert.ok(fs.existsSync(c.cache))
    assert.ok(c.ix.lastIndexedAt !== null)
    const mkIx = () => new Indexer({ cacheFile: c.cache, projectsDirs: [c.projects], log: (m) => c.logs.push(m) })
    const ix2 = mkIx()
    await ix2.load()
    assert.equal(ix2.query([ROOT]).items.length, 1)
    assert.equal((await ix2.scan([ROOT])).filesRead, 0)

    fs.writeFileSync(c.cache, '{not json')
    const ix3 = mkIx()
    await ix3.load()
    assert.equal(ix3.query([ROOT]).items.length, 0)
    assert.ok(c.logs.some((l) => l.includes('corrupt')))

    fs.writeFileSync(c.cache, JSON.stringify({ version: 0, files: {} }))
    const ix4 = mkIx()
    await ix4.load()
    assert.equal(ix4.query([ROOT]).items.length, 0)

    await ix2.clear()
    assert.ok(!fs.existsSync(c.cache))
    assert.equal(ix2.query([ROOT]).items.length, 0)
  } finally {
    cleanup(c)
  }
})

test('missing cache file and missing projects dir are fine', async () => {
  const c = mk()
  try {
    const ix = new Indexer({ cacheFile: path.join(c.tmp, 'a', 'b', 'c.json'), projectsDirs: [path.join(c.tmp, 'nope')], log: () => {} })
    await ix.load()
    const r = await ix.scan([ROOT])
    assert.equal(r.filesRead, 0)
    assert.deepEqual(ix.query([ROOT]).items, [])
  } finally {
    cleanup(c)
  }
})

test('query scopes by root cwd; prefix-dir collisions resolved; subfolders and nested dirs skipped', async () => {
  const c = mk()
  try {
    const other = 'C:\\work\\demo-web'
    const otherDir = path.join(c.projects, encodeProjectDir(other))
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'o.jsonl'), jl([toolUse('o1', {}, { cwd: other, sid: 'sess-o' }), result('o1', pub('OtherSlug'), { cwd: other, sid: 'sess-o' })]))
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('MineSlug'))])
    // sub-session started in a subfolder of the root
    write(c, 'sub.jsonl', [toolUse('t2', {}, { cwd: ROOT + '\\pkg', sid: 'sess-sub' }), result('t2', pub('SubSlug'), { cwd: ROOT + '\\pkg', sid: 'sess-sub' })])
    // nested transcripts must be ignored
    fs.mkdirSync(path.join(c.dir, 'subagents'))
    fs.writeFileSync(path.join(c.dir, 'subagents', 'agent.jsonl'), jl([toolUse('n1', {}), result('n1', pub('NestedSlug'))]))
    await c.ix.scan([ROOT, other])
    const mine = c.ix.query([ROOT])
    assert.deepEqual(mine.items.map((i) => i.key).sort(), ['claude:MineSlug', 'claude:SubSlug'])
    assert.deepEqual(Object.keys(mine.sessions).sort(), ['sess-1', 'sess-sub'])
    const both = c.ix.query([ROOT, other])
    assert.equal(both.items.length, 3)
    assert.deepEqual(c.ix.query([other.toLowerCase().replace(/\\/g, '/')]).items.map((i) => i.key), ['claude:OtherSlug'])
    assert.equal(c.ix.query(['C:\\elsewhere']).items.length, 0)
    // scanning only ROOT matches both dirs by prefix, still cwd-scoped
    const c2 = new Indexer({ cacheFile: path.join(c.tmp, 'c2.json'), projectsDirs: [c.projects], log: () => {} })
    await c2.scan([ROOT])
    assert.deepEqual(c2.query([ROOT]).items.map((i) => i.key).sort(), ['claude:MineSlug', 'claude:SubSlug'])
  } finally {
    cleanup(c)
  }
})

test('items are sorted by updatedAt desc; session title is the last ai-title/custom-title', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [
      { type: 'ai-title', aiTitle: 'Old title', sessionId: SID },
      toolUse('t1', {}, { at: '2026-01-02T10:00:00.000Z' }),
      result('t1', pub('Old'), { at: '2026-01-02T10:00:01.000Z' }),
      toolUse('t2', {}, { at: '2026-01-03T10:00:00.000Z' }),
      result('t2', pub('New'), { at: '2026-01-03T10:00:01.000Z' }),
      { type: 'custom-title', customTitle: 'Final title', sessionId: SID }
    ])
    await c.ix.scan([ROOT])
    const q = c.ix.query([ROOT])
    assert.deepEqual(q.items.map((i) => i.key), ['claude:New', 'claude:Old'])
    assert.equal(q.sessions[SID]!.title, 'Final title')
    assert.equal(q.sessions[SID]!.firstAt, Date.parse('2026-01-02T10:00:00.000Z'))
    assert.equal(q.sessions[SID]!.lastAt, Date.parse('2026-01-03T10:00:01.000Z'))
  } finally {
    cleanup(c)
  }
})

test('rev bumps on change; unparseable lines are skipped and logged once per file', async () => {
  const c = mk()
  try {
    fs.writeFileSync(
      path.join(c.dir, 's.jsonl'),
      '{"type":"assistant","name":"Artifact" broken\n{"type":"ai-title" also broken "ai-title"\n' + jl([toolUse('t1', {}), result('t1', pub('Fine'))])
    )
    const r0 = c.ix.rev
    await c.ix.scan([ROOT])
    assert.ok(c.ix.rev > r0)
    assert.equal(c.ix.query([ROOT]).items.length, 1)
    assert.equal(c.logs.filter((l) => l.includes('unparseable')).length, 1)
    const r1 = c.ix.rev
    await c.ix.scan([ROOT])
    assert.equal(c.ix.rev, r1)
  } finally {
    cleanup(c)
  }
})

test('abort signal stops scanning between files and keeps consistent state', async () => {
  const c = mk()
  try {
    write(c, 'a.jsonl', [toolUse('t1', {}), result('t1', pub('A1'))])
    const ac = new AbortController()
    ac.abort()
    const r = await c.ix.scan([ROOT], ac.signal)
    assert.equal(r.filesRead, 0)
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 1)
  } finally {
    cleanup(c)
  }
})

test('static fixture transcript indexes as expected', async () => {
  const c = mk('C:\\work\\demo')
  try {
    const fixture = fileURLToPath(new URL('../../test/fixtures/transcripts/sample.jsonl', import.meta.url))
    assert.ok(fs.existsSync(fixture), `fixture missing: ${fixture}`)
    fs.copyFileSync(fixture, path.join(c.dir, 'sample.jsonl'))
    await c.ix.scan(['C:\\work\\demo'])
    const q = c.ix.query(['C:\\work\\demo'])
    assert.equal(q.items.length, 1)
    assert.equal(q.items[0]!.key, 'claude:FixtureSlug123')
    assert.equal(q.items[0]!.title, 'Fixture Title')
    assert.equal(q.sessions['sess-fixture-1']!.title, 'Synthetic session title')
  } finally {
    cleanup(c)
  }
})

// ---- review-fix tests ----

const cacheFileState = (c: Ctx, file: string) => {
  const j = JSON.parse(fs.readFileSync(c.cache, 'utf8'))
  return j.files[path.join(c.dir, file)] as { offset: number; size: number } | undefined
}

test('lines straddling the 1 MB chunk boundary keep correct offsets across two incremental scans', async () => {
  const c = mk()
  try {
    fs.writeFileSync(path.join(c.scratch, 'v.html'), '<p/>')
    // uuid-less visual lines get their id from the byte offset: wrong offsets would collapse them.
    const noUuid = (t: string) => {
      const l = text(t) as Record<string, unknown>
      delete l.uuid
      return l
    }
    const pad = { type: 'user', sessionId: SID, pad: 'x'.repeat(1_500_000) }
    write(c, 's.jsonl', [scratchAtt(c.scratch), noUuid('::orca-visual{file="v.html"}'), pad, noUuid('::orca-visual{file="v.html"}')])
    assert.ok(fs.statSync(path.join(c.dir, 's.jsonl')).size >= 1_048_576)
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items[0]!.publishCount, 2)
    assert.equal(cacheFileState(c, 's.jsonl')!.offset, fs.statSync(path.join(c.dir, 's.jsonl')).size)
    append(c, 's.jsonl', [{ type: 'user', sessionId: SID, pad: 'y'.repeat(1_048_000) }, noUuid('::orca-visual{file="v.html"}'), noUuid('::orca-visual{file="v.html"}')])
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items[0]!.publishCount, 4)
    assert.equal(cacheFileState(c, 's.jsonl')!.offset, fs.statSync(path.join(c.dir, 's.jsonl')).size)
    assert.equal((await c.ix.scan([ROOT])).filesRead, 0)
  } finally {
    cleanup(c)
  }
})

test('a single interesting line larger than 1 MB is parsed', async () => {
  const c = mk()
  try {
    const big = 'd'.repeat(1_300_000)
    write(c, 's.jsonl', [toolUse('big1', { description: big }), result('big1', pub('BigSlug'))])
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    assert.equal(items.length, 1)
    assert.equal(items[0]!.description!.length, big.length)
  } finally {
    cleanup(c)
  }
})

test('only https://claude.ai/(code/)artifact/<slug> URLs are indexed', async () => {
  const c = mk()
  try {
    const bad = [
      'https://evil.example/claude.ai/artifact/X1',
      'https://notclaude.ai/artifact/X2',
      'http://claude.ai/artifact/X3',
      'https://claude.ai.evil.example/artifact/X4',
      'javascript:alert(1)//claude.ai/artifact/X5',
      'https://claude.ai/artifact/'
    ]
    const lines: unknown[] = []
    bad.forEach((u, i) => lines.push(toolUse(`b${i}`, {}), result(`b${i}`, { url: u, title: 'x' })))
    lines.push(toolUse('g1', {}), result('g1', { url: 'https://claude.ai/code/artifact/Good_1?x=1#y' }))
    lines.push(toolUse('g2', {}), result('g2', { url: 'https://claude.ai/artifact/Good2/' }))
    write(c, 's.jsonl', lines)
    await c.ix.scan([ROOT])
    assert.deepEqual(c.ix.query([ROOT]).items.map((i) => i.key).sort(), ['claude:Good2', 'claude:Good_1'])
  } finally {
    cleanup(c)
  }
})

test('pending publish survives restart (new Indexer on the same cache)', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', { description: 'D' })])
    await c.ix.scan([ROOT])
    const ix2 = new Indexer({ cacheFile: c.cache, projectsDirs: [c.projects], log: () => {} })
    await ix2.load()
    append(c, 's.jsonl', [result('t1', pub('Restart'))])
    await ix2.scan([ROOT])
    const items = ix2.query([ROOT]).items
    assert.deepEqual(items.map((i) => i.key), ['claude:Restart'])
    assert.equal(items[0]!.description, 'D')
  } finally {
    cleanup(c)
  }
})

test('pending visual survives restart, both orders', async () => {
  for (const order of ['directive-first', 'scratch-first'] as const) {
    const c = mk()
    try {
      fs.writeFileSync(path.join(c.scratch, 'p.html'), '<p/>')
      const mkIx = () => new Indexer({ cacheFile: c.cache, projectsDirs: [c.projects], log: () => {} })
      const first = order === 'directive-first' ? text('::orca-visual{file="p.html"}') : scratchAtt(c.scratch)
      const second = order === 'directive-first' ? scratchAtt(c.scratch) : text('::orca-visual{file="p.html"}')
      write(c, 's.jsonl', [first])
      await c.ix.scan([ROOT])
      assert.equal(c.ix.query([ROOT]).items.length, 0)
      const ix2 = mkIx()
      await ix2.load()
      append(c, 's.jsonl', [second])
      await ix2.scan([ROOT])
      assert.equal(ix2.query([ROOT]).items.length, 1, order)
    } finally {
      cleanup(c)
    }
  }
})

test('vanished transcript is forgotten; other roots entries kept; deleted project dir pruned', async () => {
  const c = mk()
  try {
    const other = 'C:\\elsewhere\\proj'
    const otherDir = path.join(c.projects, encodeProjectDir(other))
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'o.jsonl'), jl([toolUse('o1', {}, { cwd: other, sid: 'sess-o' }), result('o1', pub('OtherRoot'), { cwd: other, sid: 'sess-o' })]))
    write(c, 'a.jsonl', [toolUse('a1', {}), result('a1', pub('A'))])
    write(c, 'b.jsonl', [toolUse('b1', {}, { sid: 'sess-b' }), result('b1', pub('B'), { sid: 'sess-b' })])
    await c.ix.scan([ROOT])
    await c.ix.scan([other])
    assert.equal(c.ix.query([ROOT]).items.length, 2)
    fs.rmSync(path.join(c.dir, 'a.jsonl'))
    const r = await c.ix.scan([ROOT])
    assert.ok(r.changed)
    assert.deepEqual(c.ix.query([ROOT]).items.map((i) => i.key), ['claude:B'])
    assert.deepEqual(c.ix.query([other]).items.map((i) => i.key), ['claude:OtherRoot'])
    // whole project dir deleted: pruned on the next scan of its root and persisted
    fs.rmSync(c.dir, { recursive: true, force: true })
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 0)
    assert.deepEqual(c.ix.query([other]).items.map((i) => i.key), ['claude:OtherRoot'])
    const persisted = JSON.parse(fs.readFileSync(c.cache, 'utf8'))
    assert.deepEqual(Object.keys(persisted.files), [path.join(otherDir, 'o.jsonl')])
  } finally {
    cleanup(c)
  }
})

test('cache entries outside projectsDirs are ignored by query', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Inside'))])
    await c.ix.scan([ROOT])
    const j = JSON.parse(fs.readFileSync(c.cache, 'utf8'))
    const [inside] = Object.values(j.files) as Array<{ events: Array<Record<string, unknown>> }>
    const stray = JSON.parse(JSON.stringify(inside))
    stray.events[0]!.key = 'claude:Stray'
    stray.events[0]!.id = 'stray'
    j.files[path.join(c.tmp, 'other-projects', encodeProjectDir(ROOT), 'x.jsonl')] = stray
    j.files[c.projects + '-evil' + path.sep + 'y.jsonl'] = stray
    fs.writeFileSync(c.cache, JSON.stringify(j))
    const ix2 = new Indexer({ cacheFile: c.cache, projectsDirs: [c.projects.toUpperCase().replace(/\\/g, '/')], log: () => {} })
    await ix2.load()
    assert.deepEqual(ix2.query([ROOT]).items.map((i) => i.key), ['claude:Inside'])
  } finally {
    cleanup(c)
  }
})

test('concurrent scan() calls are serialized (no duplicate events)', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Once'))])
    const rs = await Promise.all([c.ix.scan([ROOT]), c.ix.scan([ROOT]), c.ix.scan([ROOT])])
    assert.equal(rs.filter((r) => r.filesRead > 0).length, 1)
    const items = c.ix.query([ROOT]).items
    assert.equal(items.length, 1)
    assert.equal(items[0]!.publishCount, 1)
    assert.equal(JSON.parse(fs.readFileSync(c.cache, 'utf8')).files[path.join(c.dir, 's.jsonl')].events.length, 1)
  } finally {
    cleanup(c)
  }
})

test('clear() after a pending scan leaves no cache file', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Gone'))])
    const p = c.ix.scan([ROOT])
    const cl = c.ix.clear()
    await Promise.all([p, cl])
    assert.ok(!fs.existsSync(c.cache))
    assert.equal(c.ix.query([ROOT]).items.length, 0)
  } finally {
    cleanup(c)
  }
})

test('same session copied under multiple projectsDirs is deduped', async () => {
  const c = mk()
  try {
    const projects2 = path.join(c.tmp, 'projects2')
    const dir2 = path.join(projects2, encodeProjectDir(ROOT))
    fs.mkdirSync(dir2, { recursive: true })
    const lines = [toolUse('t1', {}), result('t1', pub('Twice'))]
    write(c, 's.jsonl', lines)
    fs.writeFileSync(path.join(dir2, 's.jsonl'), jl(lines))
    const ix = new Indexer({ cacheFile: path.join(c.tmp, 'multi.json'), projectsDirs: [c.projects, projects2], log: () => {} })
    const r = await ix.scan([ROOT])
    assert.equal(r.filesRead, 2)
    const q = ix.query([ROOT])
    assert.equal(q.items.length, 1)
    assert.equal(q.items[0]!.publishCount, 1)
    assert.equal(Object.keys(q.sessions).length, 1)
  } finally {
    cleanup(c)
  }
})

test('abort mid-file (on the second chunk read) then rescan gets everything', async () => {
  const c = mk()
  const origOpen = fs.promises.open
  try {
    const lines: unknown[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(toolUse(`m${i}`, { description: 'z'.repeat(700_000) }), result(`m${i}`, pub(`Multi${i}`)))
    }
    write(c, 's.jsonl', lines)
    assert.ok(fs.statSync(path.join(c.dir, 's.jsonl')).size > 3 * 1_048_576)
    const ac = new AbortController()
    let reads = 0
    fs.promises.open = (async (...args: Parameters<typeof origOpen>) => {
      const fh = await origOpen(...args)
      const origRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>
      ;(fh as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        if (++reads === 2) ac.abort()
        return origRead(...a)
      }
      return fh
    }) as typeof fs.promises.open
    const r1 = await c.ix.scan([ROOT], ac.signal)
    fs.promises.open = origOpen
    assert.equal(reads, 2)
    assert.ok(r1.filesRead >= 1)
    assert.ok(c.ix.query([ROOT]).items.length < 5)
    await c.ix.scan([ROOT])
    const items = c.ix.query([ROOT]).items
    assert.equal(items.length, 5)
    assert.equal(items.every((i) => i.publishCount === 1), true)
  } finally {
    fs.promises.open = origOpen
    cleanup(c)
  }
})

test('scan() reports failed count for unreadable files and directories, and cacheWriteError', async () => {
  const c = mk()
  const origOpen = fs.promises.open
  try {
    write(c, 'ok.jsonl', [toolUse('t1', {}), result('t1', pub('Fine'))])
    write(c, 'locked.jsonl', [toolUse('t2', {}), result('t2', pub('Locked'))])
    fs.promises.open = (async (...args: Parameters<typeof origOpen>) => {
      if (String(args[0]).endsWith('locked.jsonl')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return origOpen(...args)
    }) as typeof fs.promises.open
    const r = await c.ix.scan([ROOT])
    fs.promises.open = origOpen
    assert.equal(r.failed, 1)
    assert.equal(r.cacheWriteError, undefined)
    assert.equal(c.logs.filter((l) => l.includes('locked.jsonl') && l.includes('EBUSY')).length, 1)
    assert.deepEqual(c.ix.query([ROOT]).items.map((i) => i.key), ['claude:Fine'])

    // projects dir that is a file -> readdir fails (not ENOENT)
    const notDir = path.join(c.tmp, 'afile')
    fs.writeFileSync(notDir, 'x')
    const ix2 = new Indexer({ cacheFile: path.join(c.tmp, 'c2.json'), projectsDirs: [notDir], log: () => {} })
    assert.equal((await ix2.scan([ROOT])).failed, 1)

    // cache path whose parent is a file -> atomic write fails
    const ix3 = new Indexer({ cacheFile: path.join(notDir, 'sub', 'c.json'), projectsDirs: [c.projects], log: () => {} })
    const r3 = await ix3.scan([ROOT])
    assert.ok(typeof r3.cacheWriteError === 'string' && r3.cacheWriteError.length > 0)
  } finally {
    fs.promises.open = origOpen
    cleanup(c)
  }
})

test('a failing scan of one file does not make the cache forget its previous state', async () => {
  const c = mk()
  const origOpen = fs.promises.open
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Keep'))])
    await c.ix.scan([ROOT])
    append(c, 's.jsonl', [toolUse('t2', {}), result('t2', pub('More'))])
    fs.promises.open = (async (...args: Parameters<typeof origOpen>) => {
      if (String(args[0]).endsWith('s.jsonl')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return origOpen(...args)
    }) as typeof fs.promises.open
    const r = await c.ix.scan([ROOT])
    fs.promises.open = origOpen
    assert.equal(r.failed, 1)
    assert.deepEqual(c.ix.query([ROOT]).items.map((i) => i.key), ['claude:Keep'])
    await c.ix.scan([ROOT])
    assert.equal(c.ix.query([ROOT]).items.length, 2)
  } finally {
    fs.promises.open = origOpen
    cleanup(c)
  }
})

test('cache: malformed events are dropped on load (and counted) instead of throwing later', async () => {
  const c = mk()
  try {
    write(c, 's.jsonl', [toolUse('t1', {}), result('t1', pub('Valid'))])
    await c.ix.scan([ROOT])
    const j = JSON.parse(fs.readFileSync(c.cache, 'utf8'))
    const good = j.files[path.join(c.dir, 's.jsonl')]
    j.files[path.join(c.dir, 'bad.jsonl')] = { ...good, events: [{ kind: 'claude', key: 'claude:Bad' }] }
    j.files[path.join(c.dir, 'bad2.jsonl')] = { ...good, events: [null] }
    fs.writeFileSync(c.cache, JSON.stringify(j))
    const ix2 = new Indexer({ cacheFile: c.cache, projectsDirs: [c.projects], log: (m) => c.logs.push(m) })
    await ix2.load()
    assert.deepEqual(ix2.query([ROOT]).items.map((i) => i.key), ['claude:Valid'])
    assert.ok(c.logs.some((l) => l.includes('dropped 2 invalid cache entries')))
  } finally {
    cleanup(c)
  }
})
