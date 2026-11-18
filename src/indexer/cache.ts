// On-disk cache: JSON, written atomically (tmp + rename).
import fs from 'node:fs'
import path from 'node:path'
import type { FileState } from './parse.ts'

export const CACHE_VERSION = 1

export type CacheData = {
  version: number
  lastIndexedAt: number | null
  files: Record<string, FileState>
}

export function emptyCache(): CacheData {
  return { version: CACHE_VERSION, lastIndexedAt: null, files: {} }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validEvent(e: unknown): boolean {
  if (!isPlain(e)) return false
  if (typeof e.key !== 'string' || typeof e.id !== 'string' || typeof e.at !== 'number') return false
  if (typeof e.sessionId !== 'string' || typeof e.cwd !== 'string' || typeof e.title !== 'string') return false
  if (e.kind === 'claude') return typeof e.url === 'string' && (e.action === 'create' || e.action === 'update')
  if (e.kind === 'visual') return typeof e.filePath === 'string' && typeof e.file === 'string'
  return false
}

function validPendingVisual(v: unknown): boolean {
  return isPlain(v) && typeof v.id === 'string' && typeof v.sessionId === 'string' && typeof v.file === 'string' && typeof v.at === 'number'
}

function validSessionPart(v: unknown): boolean {
  return isPlain(v) && typeof v.firstAt === 'number' && typeof v.lastAt === 'number'
}

function validFileState(v: unknown): v is FileState {
  return (
    isPlain(v) &&
    typeof v.size === 'number' &&
    typeof v.mtimeMs === 'number' &&
    typeof v.offset === 'number' &&
    isPlain(v.pending) &&
    Object.values(v.pending).every(isPlain) &&
    Array.isArray(v.pendingVisuals) &&
    v.pendingVisuals.every(validPendingVisual) &&
    isPlain(v.scratch) &&
    Object.values(v.scratch).every((d) => typeof d === 'string') &&
    Array.isArray(v.events) &&
    v.events.every(validEvent) &&
    isPlain(v.sessions) &&
    Object.values(v.sessions).every(validSessionPart)
  )
}

/** Returns the cache, or an empty one (plus a reason) when missing, corrupt or from another version. */
export async function readCache(file: string): Promise<{ data: CacheData; reason?: string; dropped?: number }> {
  let raw: string
  try {
    raw = await fs.promises.readFile(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { data: emptyCache(), reason: code === 'ENOENT' ? 'no cache file' : `cache unreadable: ${String(e)}` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { data: emptyCache(), reason: 'cache is corrupt (invalid JSON)' }
  }
  if (!isPlain(json) || json.version !== CACHE_VERSION || !isPlain(json.files)) {
    return { data: emptyCache(), reason: 'cache has an unsupported version or shape' }
  }
  const files: Record<string, FileState> = {}
  let dropped = 0
  for (const [p, st] of Object.entries(json.files)) {
    if (validFileState(st)) files[p] = st
    else dropped++
  }
  const lastIndexedAt = typeof json.lastIndexedAt === 'number' ? json.lastIndexedAt : null
  return { data: { version: CACHE_VERSION, lastIndexedAt, files }, dropped }
}

export async function writeCacheAtomic(file: string, data: CacheData): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8')
  try {
    await fs.promises.rename(tmp, file)
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

export async function removeCache(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true })
}
