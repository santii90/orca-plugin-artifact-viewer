// Shared data model: the worker builds it, the panel renders it (panel JS mirrors these shapes).
// All timestamps are epoch milliseconds. All paths are absolute, as found on disk (Windows: backslashes).

export type ItemKind = 'claude' | 'visual'

/** One publish (create or update) of an item, newest last. Capped at MAX_VERSIONS per item. */
export type ItemVersion = {
  at: number
  sessionId: string
  /** claude: 'create' when the publish had no `url` input, else 'update'. visual: always 'create'. */
  action: 'create' | 'update'
  /** claude: toolUseResult.version (opaque string id) when present. */
  version?: string
}

/** A chat session that produced or updated an item. */
export type SessionRef = {
  sessionId: string
  /** Last `ai-title`/`custom-title` seen in that transcript; may be absent. */
  title?: string
  /** `cwd` of the session's lines (the worktree or a subfolder of it). */
  cwd: string
  /** `entrypoint` of the session's lines: 'orca' | 'cli' | 'claude-desktop' | 'sdk-cli' | ... */
  entrypoint?: string
  gitBranch?: string
  firstAt: number
  lastAt: number
  /** Absolute path of the transcript file. */
  transcriptPath: string
}

export type Item = {
  /** claude: 'claude:<slug>' (slug from claude.ai/(code/)artifact/<slug>). visual: 'visual:<chatId>/<file>'. */
  key: string
  kind: ItemKind
  /** claude: canonical URL as published. visual: file:/// URL of filePath. */
  url: string
  /** visual only: absolute path of the HTML file. */
  filePath?: string
  title: string
  /** claude: the publish `description` input when given. */
  description?: string
  /** claude: Artifact type URL when created from a type (deck, doc, dashboard...). */
  artifactType?: string
  firstSeenAt: number
  updatedAt: number
  publishCount: number
  versions: ItemVersion[]
  /** Session ids, in first-seen order; details in ListResponse.sessions. */
  sessionIds: string[]
  /** `cwd` of the latest publish. */
  lastCwd: string
}

export type WorktreeRef = {
  path: string
  name: string
  branch: string | null
  /** True for the focused worktree. */
  current: boolean
}

export type Scope = 'repo' | 'worktree'

export type ListContext = {
  /** Null when no workspace is focused or it could not be resolved to a local path. */
  worktreePath: string | null
  worktreeName: string | null
  repoName: string | null
  /** Worktrees considered for the requested scope (one for 'worktree'). */
  worktrees: WorktreeRef[]
}

export type ListResponse = {
  /** Increases whenever the index changes; panels re-request on `artifacts.changed`. */
  rev: number
  /** True while a background scan is running; items may be incomplete. */
  indexing: boolean
  scope: Scope
  context: ListContext
  /** Sorted by updatedAt desc. Only items whose sessions' cwd lies inside a scoped worktree. */
  items: Item[]
  /** Referenced by Item.sessionIds. */
  sessions: Record<string, SessionRef>
  pins: string[]
  lastIndexedAt: number | null
  /** Human-readable problem to show in the panel (e.g. no workspace, projects dir missing). */
  error?: string
}

export type OpenTarget = 'orca'
export type OpenResult = { ok: boolean; reason?: string }

export const MAX_VERSIONS = 50
