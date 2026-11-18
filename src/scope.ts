// Maps the focused Orca workspace to the worktree paths whose Claude sessions we should list.
import type { ListContext, Scope, WorktreeRef } from './types.ts'

export type ScopeHost = {
  call(method: any, params?: any): Promise<any>
  has(method: string): boolean
}

type Row = {
  id: string
  kind?: string
  name: string
  project?: string | null
  projectId?: string | null
  path: string
  branch: string | null
  hostId: string | null
}

export type ResolvedScope = {
  context: ListContext
  roots: string[]
  /** Set when the focused workspace exists but could not be matched to a local row. */
  error?: string
}

const stripRef = (b: string | null | undefined): string | null => (b ? b.replace(/^refs\/heads\//, '') : null)
const isLocal = (r: Row): boolean => r.hostId == null || r.hostId === 'local'
const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

let logged = false
/** Test hook: lets each test see the "first resolve" log. */
export function resetScopeLog(): void {
  logged = false
}

export async function resolveScope(host: ScopeHost, scope: Scope, log?: (msg: string) => void): Promise<ResolvedScope> {
  const ctx = (await host.call('workspace.readContext')) as {
    workspaceId?: string
    branch: string
    displayName: string
  } | null
  if (!ctx) throw new Error('No workspace focused')

  const listed = (await host.call('workspace.list')) as { workspaces?: Row[] } | null
  const rows = (listed?.workspaces ?? []).filter(isLocal)

  let how = 'id'
  let current = ctx.workspaceId ? rows.find((r) => r.id === ctx.workspaceId) : undefined
  if (!current) {
    const branch = stripRef(ctx.branch)
    const sameBranch = rows.filter((r) => stripRef(r.branch) === branch)
    const byName = sameBranch.find((r) => r.name === ctx.displayName)
    if (byName) {
      current = byName
      how = 'branch+name'
    } else if (sameBranch.length === 1) {
      current = sameBranch[0]
      how = 'branch'
    }
  }

  if (!logged && log) {
    logged = true
    const sample = rows.slice(0, 3).map((r) => `${r.id}|${r.branch}|${r.hostId}`).join(' ; ')
    log(
      `scope: ctx.workspaceId=${ctx.workspaceId ?? '-'} branch=${ctx.branch} -> ${current ? `matched by ${how} (${current.id})` : 'no match'}; rows=${rows.length} [${sample}]`
    )
  }

  if (!current) {
    return {
      context: { worktreePath: null, worktreeName: ctx.displayName ?? null, repoName: null, worktrees: [] },
      roots: [],
      error: 'Could not match the focused workspace to a local worktree'
    }
  }

  const group = scope === 'repo' && current.projectId ? rows.filter((r) => r.projectId === current!.projectId) : [current]
  if (!group.includes(current)) group.push(current)

  let repoName: string | null = null
  if (current.projectId && host.has('project.list')) {
    try {
      const pl = (await host.call('project.list')) as { projects?: { id: string; name: string }[] } | null
      repoName = pl?.projects?.find((p) => p.id === current!.projectId)?.name ?? null
    } catch (e) {
      log?.(`scope: project.list failed (${e instanceof Error ? e.message : String(e)}); using the path-based name`)
    }
  }
  if (!repoName) {
    const shortest = [...group].sort((a, b) => a.path.length - b.path.length)[0]
    repoName = base(shortest.path)
  }

  const worktrees: WorktreeRef[] = group.map((r) => ({
    path: r.path,
    name: r.name,
    branch: stripRef(r.branch),
    current: r === current
  }))
  return {
    context: { worktreePath: current.path, worktreeName: current.name, repoName, worktrees },
    roots: worktrees.map((w) => w.path)
  }
}
