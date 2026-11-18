// Combines per-file contributions into items and session refs.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { MAX_VERSIONS } from '../types.ts'
import type { Item, ItemVersion, SessionRef } from '../types.ts'
import type { ClaudeEvent, FileState, VisualEvent } from './parse.ts'

export type MergedItem = { item: Item; cwds: string[] }
export type MergeResult = { items: MergedItem[]; sessions: Record<string, SessionRef> }

export function mergeSessions(files: Record<string, FileState>): Record<string, SessionRef> {
  const out: Record<string, SessionRef> = {}
  for (const [filePath, fs0] of Object.entries(files)) {
    for (const [sid, part] of Object.entries(fs0.sessions)) {
      const cur = out[sid]
      if (!cur) {
        out[sid] = {
          sessionId: sid,
          title: part.title,
          cwd: part.cwd ?? '',
          entrypoint: part.entrypoint,
          gitBranch: part.gitBranch,
          firstAt: part.firstAt,
          lastAt: part.lastAt,
          transcriptPath: filePath
        }
        continue
      }
      if (part.firstAt && (!cur.firstAt || part.firstAt < cur.firstAt)) cur.firstAt = part.firstAt
      if (!cur.cwd && part.cwd) cur.cwd = part.cwd
      if (!cur.entrypoint && part.entrypoint) cur.entrypoint = part.entrypoint
      if (!cur.gitBranch && part.gitBranch) cur.gitBranch = part.gitBranch
      if (part.lastAt > cur.lastAt) {
        cur.lastAt = part.lastAt
        cur.transcriptPath = filePath
        if (part.title) cur.title = part.title
      } else if (!cur.title && part.title) cur.title = part.title
    }
  }
  return out
}

export function mergeItems(
  files: Record<string, FileState>,
  fileExists: (p: string) => boolean = fs.existsSync
): MergedItem[] {
  const groups = new Map<string, Array<ClaudeEvent | VisualEvent>>()
  const seen = new Set<string>()
  for (const f of Object.values(files)) {
    for (const ev of f.events) {
      const dk = `${ev.key}\u0000${ev.id}`
      if (seen.has(dk)) continue
      seen.add(dk)
      let g = groups.get(ev.key)
      if (!g) groups.set(ev.key, (g = []))
      g.push(ev)
    }
  }
  const existsCache = new Map<string, boolean>()
  const exists = (p: string): boolean => {
    let v = existsCache.get(p)
    if (v === undefined) existsCache.set(p, (v = fileExists(p)))
    return v
  }

  const out: MergedItem[] = []
  for (const [key, evs] of groups) {
    const first = evs[0]!
    if (first.kind === 'visual' && !exists(first.filePath)) continue
    evs.sort((a, b) => a.at - b.at)
    const publishCount = evs.length
    const capped = evs.length > MAX_VERSIONS ? evs.slice(evs.length - MAX_VERSIONS) : evs
    const versions: ItemVersion[] = capped.map((e) => {
      const v: ItemVersion = {
        at: e.at,
        sessionId: e.sessionId,
        action: e.kind === 'claude' ? e.action : 'create'
      }
      if (e.kind === 'claude' && e.version) v.version = e.version
      return v
    })
    const last = evs[evs.length - 1]!
    const sessionIds: string[] = []
    for (const e of evs) if (!sessionIds.includes(e.sessionId)) sessionIds.push(e.sessionId)
    const cwds = [...new Set(evs.map((e) => e.cwd).filter(Boolean))]
    const item: Item = {
      key,
      kind: last.kind,
      url: '',
      title: last.title,
      firstSeenAt: evs[0]!.at,
      updatedAt: last.at,
      publishCount,
      versions,
      sessionIds,
      lastCwd: last.cwd
    }
    if (last.kind === 'claude') {
      item.url = last.url
      let desc: string | undefined
      let type: string | undefined
      for (const e of evs) {
        if (e.kind !== 'claude') continue
        if (e.description) desc = e.description
        if (e.artifactType) type = e.artifactType
      }
      if (desc) item.description = desc
      if (type) item.artifactType = type
    } else {
      item.filePath = last.filePath
      item.url = pathToFileURL(last.filePath).href
    }
    out.push({ item, cwds })
  }
  out.sort((a, b) => b.item.updatedAt - a.item.updatedAt)
  return out
}
