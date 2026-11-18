import { test, assert } from 'orca/testing'
import { resolveScope, resetScopeLog } from './scope.ts'

const rows = [
  { id: 'r1::C:/dev/app', kind: 'worktree', name: 'main', project: 'app', projectId: 'p1', path: 'C:/dev/app', branch: 'refs/heads/main', hostId: 'local' },
  { id: 'r1::C:/wt/app/feat', kind: 'worktree', name: 'feat', projectId: 'p1', path: 'C:/wt/app/feat', branch: 'refs/heads/feat/x', hostId: 'local' },
  { id: 'r1::/srv/app', kind: 'worktree', name: 'main', projectId: 'p1', path: '/srv/app', branch: 'refs/heads/main', hostId: 'ssh:box' },
  { id: 'r2::C:/dev/other', kind: 'worktree', name: 'main', projectId: 'p2', path: 'C:/dev/other', branch: 'refs/heads/main', hostId: null }
]

function fakeHost(ctx: unknown, opts: { projects?: boolean } = { projects: true }) {
  return {
    has: (m: string) => (m === 'project.list' ? !!opts.projects : true),
    async call(method: string) {
      if (method === 'workspace.readContext') return ctx
      if (method === 'workspace.list') return { workspaces: rows, truncated: false }
      if (method === 'project.list') return { projects: [{ id: 'p1', name: 'My App' }] }
      throw new Error('unexpected ' + method)
    }
  }
}

test('matches by workspaceId; worktree scope returns just that row', async () => {
  const r = await resolveScope(fakeHost({ workspaceId: 'r1::C:/wt/app/feat', branch: 'feat/x', displayName: 'feat', terminals: [] }), 'worktree')
  assert.deepEqual(r.roots, ['C:/wt/app/feat'])
  assert.equal(r.context.worktreePath, 'C:/wt/app/feat')
  assert.equal(r.context.worktrees[0].current, true)
  assert.equal(r.context.worktrees[0].branch, 'feat/x')
})

test('repo scope groups by projectId and ignores remote hosts', async () => {
  const r = await resolveScope(fakeHost({ workspaceId: 'r1::C:/dev/app', branch: 'main', displayName: 'main', terminals: [] }), 'repo')
  assert.deepEqual(r.roots, ['C:/dev/app', 'C:/wt/app/feat'])
  assert.equal(r.context.repoName, 'My App')
  assert.deepEqual(r.context.worktrees.map((w) => w.current), [true, false])
})

test('falls back to branch + name when the id is unknown', async () => {
  const r = await resolveScope(fakeHost({ workspaceId: 'zzz', branch: 'main', displayName: 'main', terminals: [] }), 'worktree')
  // two local rows are on main (p1 and p2): name disambiguates nothing, but the first name match wins
  assert.equal(r.context.worktreePath, 'C:/dev/app')
})

test('falls back to unique branch alone', async () => {
  const r = await resolveScope(fakeHost({ branch: 'feat/x', displayName: 'renamed', terminals: [] }), 'worktree')
  assert.equal(r.context.worktreePath, 'C:/wt/app/feat')
})

test('no match yields an error and no roots', async () => {
  const r = await resolveScope(fakeHost({ branch: 'nope', displayName: 'nope', terminals: [] }), 'repo')
  assert.deepEqual(r.roots, [])
  assert.match(r.error ?? '', /match/)
})

test('repo name falls back to the shortest path basename without project.list', async () => {
  const r = await resolveScope(fakeHost({ workspaceId: 'r1::C:/dev/app', branch: 'main', displayName: 'main', terminals: [] }, { projects: false }), 'repo')
  assert.equal(r.context.repoName, 'app')
})

test('no focused workspace rejects', async () => {
  await assert.rejects(resolveScope(fakeHost(null), 'repo'), /No workspace focused/)
})

test('logs once on first resolve', async () => {
  resetScopeLog()
  const logs: string[] = []
  const h = fakeHost({ workspaceId: 'r1::C:/dev/app', branch: 'main', displayName: 'main', terminals: [] })
  await resolveScope(h, 'repo', (m) => logs.push(m))
  await resolveScope(h, 'repo', (m) => logs.push(m))
  assert.equal(logs.length, 1)
})
