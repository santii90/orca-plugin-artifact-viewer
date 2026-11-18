// Per-line extraction. A FileState accumulates everything one transcript contributes; it is persisted in the cache.
import path from 'node:path'

export type PendingPublish = {
  sessionId: string
  cwd: string
  inputTitle?: string
  description?: string
  hasUrl: boolean
}

export type PendingVisual = {
  id: string
  at: number
  sessionId: string
  cwd: string
  file: string
  title?: string
}

export type ClaudeEvent = {
  kind: 'claude'
  key: string
  /** tool_use id; used to dedupe replayed lines. */
  id: string
  at: number
  sessionId: string
  cwd: string
  action: 'create' | 'update'
  version?: string
  title: string
  description?: string
  artifactType?: string
  url: string
}

export type VisualEvent = {
  kind: 'visual'
  key: string
  /** line uuid (or byte offset) + ':' + directive index. */
  id: string
  at: number
  sessionId: string
  cwd: string
  title: string
  file: string
  filePath: string
}

export type SessionPart = {
  cwd?: string
  entrypoint?: string
  gitBranch?: string
  firstAt: number
  lastAt: number
  title?: string
}

export type FileState = {
  size: number
  mtimeMs: number
  offset: number
  pending: Record<string, PendingPublish>
  pendingVisuals: PendingVisual[]
  /** sessionId -> absolute chat-scratch dir. */
  scratch: Record<string, string>
  events: Array<ClaudeEvent | VisualEvent>
  sessions: Record<string, SessionPart>
}

export function newFileState(): FileState {
  return { size: 0, mtimeMs: 0, offset: 0, pending: {}, pendingVisuals: [], scratch: {}, events: [], sessions: {} }
}

/** Cheap substring prefilter (on raw line bytes) deciding whether a line is worth JSON.parse. */
export const PREFILTER_NEEDLES = ['"name":"Artifact"', '::orca-visual', 'additionalWorkingDirectories', '"ai-title"', '"custom-title"']

export function lineIsInteresting(buf: Buffer, state: FileState): boolean {
  for (const n of PREFILTER_NEEDLES) if (buf.includes(n)) return true
  // Tool results: only worth parsing when they answer a still-pending publish.
  if (buf.includes('toolUseResult')) {
    for (const id of Object.keys(state.pending)) if (buf.includes(id)) return true
  }
  return false
}

const SLUG_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/
const SCRATCH_RE = /[\\/]orca[\\/]chat-scratch[\\/]([0-9a-f]+)$/i
const FILE_RE = /^[A-Za-z0-9._-]+\.html$/

type Obj = Record<string, unknown>
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function touchSession(state: FileState, line: Obj): SessionPart | null {
  const sid = str(line.sessionId)
  if (!sid) return null
  const at = toMs(line.timestamp)
  let s = state.sessions[sid]
  if (!s) {
    s = { firstAt: at ?? 0, lastAt: at ?? 0 }
    state.sessions[sid] = s
  }
  if (at !== undefined) {
    if (!s.firstAt || at < s.firstAt) s.firstAt = at
    if (at > s.lastAt) s.lastAt = at
  }
  if (line.type === 'user' || line.type === 'assistant' || line.type === 'attachment') {
    if (!s.cwd) s.cwd = str(line.cwd)
    if (!s.entrypoint) s.entrypoint = str(line.entrypoint)
    if (!s.gitBranch) s.gitBranch = str(line.gitBranch)
  }
  return s
}

/** Removes fenced code blocks (an unclosed fence swallows the rest) and inline code spans. */
export function stripCode(text: string): string {
  const out: string[] = []
  let fenced = false
  for (const l of text.split('\n')) {
    if (/^\s*```/.test(l)) {
      fenced = !fenced
      continue
    }
    if (!fenced) out.push(l.replace(/`[^`\n]*`/g, ''))
  }
  return out.join('\n')
}

export function parseDirectives(text: string): Array<{ file: string; title?: string }> {
  const res: Array<{ file: string; title?: string }> = []
  const clean = stripCode(text)
  for (const m of clean.matchAll(/::orca-visual\{([^}]*)\}/g)) {
    const attrs = m[1] ?? ''
    const f = /\bfile="([^"]*)"/.exec(attrs)?.[1]
    if (!f || !FILE_RE.test(f)) continue
    const t = /\btitle="([^"]*)"/.exec(attrs)?.[1]
    res.push({ file: f, title: t || undefined })
  }
  return res
}

function addVisual(state: FileState, p: PendingVisual, dir: string): void {
  const chatId = SCRATCH_RE.exec(dir)?.[1]
  if (!chatId) return
  state.events.push({
    kind: 'visual',
    key: `visual:${chatId}/${p.file}`,
    id: p.id,
    at: p.at,
    sessionId: p.sessionId,
    cwd: p.cwd,
    title: p.title || p.file.replace(/\.html$/i, ''),
    file: p.file,
    filePath: path.join(dir, p.file)
  })
}

/** Applies one parsed line to the state. `pos` is the byte offset of the line (fallback id). */
export function applyLine(state: FileState, line: unknown, pos: number): void {
  if (!isObj(line)) return
  const type = line.type
  const sessionId = str(line.sessionId)
  if (!sessionId) return
  const sess = touchSession(state, line)
  if (!sess) return
  const at = toMs(line.timestamp) ?? 0
  const cwd = str(line.cwd) ?? sess.cwd ?? ''

  if (type === 'ai-title') {
    const t = str(line.aiTitle)
    if (t) sess.title = t
    return
  }
  if (type === 'custom-title') {
    const t = str(line.customTitle)
    if (t) sess.title = t
    return
  }

  if (type === 'attachment') {
    const att = line.attachment
    if (!isObj(att) || att.type !== 'environment' || !isObj(att.snapshot)) return
    const dirs = att.snapshot.additionalWorkingDirectories
    if (!Array.isArray(dirs)) return
    for (const d of dirs) {
      if (typeof d === 'string' && SCRATCH_RE.test(d)) {
        state.scratch[sessionId] = d
        const rest: PendingVisual[] = []
        for (const p of state.pendingVisuals) {
          if (p.sessionId === sessionId) addVisual(state, p, d)
          else rest.push(p)
        }
        state.pendingVisuals = rest
      }
    }
    return
  }

  const message = isObj(line.message) ? line.message : null
  const content = message && Array.isArray(message.content) ? message.content : null
  if (!content) return

  if (type === 'assistant') {
    if (line.isSidechain) return
    const uuid = str(line.uuid) ?? `@${pos}`
    let idx = 0
    for (const c of content) {
      if (!isObj(c)) continue
      if (c.type === 'tool_use' && c.name === 'Artifact') {
        const input = isObj(c.input) ? c.input : {}
        const action = input.action
        if ((action === undefined || action === 'publish') && input.asset !== true) {
          const id = str(c.id)
          if (id) {
            state.pending[id] = {
              sessionId,
              cwd,
              inputTitle: str(input.title),
              description: str(input.description),
              hasUrl: typeof input.url === 'string' && input.url.length > 0
            }
          }
        }
      } else if (c.type === 'text' && typeof c.text === 'string' && c.text.includes('::orca-visual')) {
        for (const d of parseDirectives(c.text)) {
          const pv: PendingVisual = { id: `${uuid}:${idx++}`, at, sessionId, cwd, file: d.file, title: d.title }
          const dir = state.scratch[sessionId]
          if (dir) addVisual(state, pv, dir)
          else state.pendingVisuals.push(pv)
        }
      }
    }
    return
  }

  if (type === 'user') {
    const tur = line.toolUseResult
    for (const c of content) {
      if (!isObj(c) || c.type !== 'tool_result') continue
      const id = str(c.tool_use_id)
      if (!id) continue
      const pend = state.pending[id]
      if (!pend) continue
      delete state.pending[id]
      if (c.is_error) continue
      if (!isObj(tur)) continue
      const url = str(tur.url)
      const slug = url ? SLUG_RE.exec(url)?.[1] : undefined
      if (!url || !slug) continue
      const typeObj = tur.type
      const created = tur.created_from_type
      const artifactType =
        (isObj(typeObj) ? str(typeObj.url) : undefined) ?? (isObj(created) ? str(created.url) : str(created))
      state.events.push({
        kind: 'claude',
        key: `claude:${slug}`,
        id,
        at,
        sessionId: pend.sessionId,
        cwd: pend.cwd || cwd,
        action: pend.hasUrl ? 'update' : 'create',
        version: str(tur.version),
        title: str(tur.title) ?? pend.inputTitle ?? pend.description ?? slug,
        description: pend.description,
        artifactType,
        url
      })
    }
  }
}
