// Project-dir encoding and cwd scoping helpers (pure functions).

/** Claude Code project dir name for a cwd: every non-alphanumeric char becomes '-'. */
export function encodeProjectDir(p: string): string {
  return trimTrailingSeparators(p).replace(/[^A-Za-z0-9]/g, '-')
}

function trimTrailingSeparators(p: string): string {
  let end = p.length
  while (end > 1 && (p[end - 1] === '\\' || p[end - 1] === '/')) end--
  return p.slice(0, end)
}

/** Slash-normalized, lowercased, without trailing slash. */
export function normalizePath(p: string): string {
  return trimTrailingSeparators(p.replace(/\\/g, '/')).toLowerCase()
}

/** A project dir may hold sessions for `root` when its name is enc(root) or enc(root) + '-' + more. */
export function dirMatchesRoot(dirName: string, root: string): boolean {
  const e = encodeProjectDir(root).toLowerCase()
  if (!e) return false
  const d = dirName.toLowerCase()
  return d === e || d.startsWith(e + '-')
}

export function dirMatchesAnyRoot(dirName: string, roots: string[]): boolean {
  return roots.some((r) => dirMatchesRoot(dirName, r))
}

/** True when `cwd` equals `root` or lies below it (path-segment boundary). */
export function isInsideRoot(cwd: string, root: string): boolean {
  const c = normalizePath(cwd)
  const r = normalizePath(root)
  if (!c || !r) return false
  return c === r || c.startsWith(r.endsWith('/') ? r : r + '/')
}

export function isInsideAnyRoot(cwd: string, roots: string[]): boolean {
  return roots.some((r) => isInsideRoot(cwd, r))
}
