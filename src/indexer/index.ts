// Transcript indexer: finds Claude artifacts and Orca chat visuals in Claude Code session transcripts.
import fs from 'node:fs'
import path from 'node:path'
import type { Item, SessionRef } from '../types.ts'
import { dirMatchesAnyRoot, isInsideAnyRoot, isInsideRoot, normalizePath } from './encode.ts'
import { emptyCache, readCache, removeCache, writeCacheAtomic } from './cache.ts'
import type { CacheData } from './cache.ts'
import { mergeItems, mergeSessions } from './merge.ts'
import { scanFile } from './scan.ts'
import type { FileState } from './parse.ts'

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch (e) {
    // Only a definite "not there" counts; other errors (EACCES, EBUSY) keep the entries.
    const code = (e as NodeJS.ErrnoException).code
    return !(code === 'ENOENT' || code === 'ENOTDIR')
  }
}

export type IndexerOptions = {
  cacheFile: string
  projectsDirs: string[]
  log: (msg: string) => void
  now?: () => number
}

export type ScanResult = { changed: boolean; filesRead: number; failed: number; cacheWriteError?: string }

export class Indexer {
  private opts: IndexerOptions
  private data: CacheData = emptyCache()
  private _rev = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: IndexerOptions) {
    this.opts = opts
  }

  get rev(): number {
    return this._rev
  }

  get lastIndexedAt(): number | null {
    return this.data.lastIndexedAt
  }

  async load(): Promise<void> {
    const { data, reason, dropped } = await readCache(this.opts.cacheFile)
    this.data = data
    if (dropped) this.opts.log(`indexer: dropped ${dropped} invalid cache entr${dropped === 1 ? 'y' : 'ies'}`)
    if (reason && reason !== 'no cache file') this.opts.log(`indexer: starting empty: ${reason}`)
    this._rev++
  }

  scan(roots: string[], signal?: AbortSignal): Promise<ScanResult> {
    // Serialize scans: they mutate shared state.
    const run = this.chain.then(() => this.doScan(roots, signal))
    this.chain = run.catch(() => {})
    return run
  }

  private async listFiles(roots: string[]): Promise<{ files: string[]; dirs: string[]; failed: number }> {
    const files: string[] = []
    const dirs: string[] = []
    let failed = 0
    for (const pd of this.opts.projectsDirs) {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(pd, { withFileTypes: true })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          failed++
          this.opts.log(`indexer: cannot read ${pd} (${code ?? 'error'}): ${String(e)}`)
        }
        continue
      }
      for (const d of entries) {
        if (!d.isDirectory() || !dirMatchesAnyRoot(d.name, roots)) continue
        const dir = path.join(pd, d.name)
        let inner: fs.Dirent[]
        try {
          inner = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch (e) {
          failed++
          this.opts.log(`indexer: cannot read ${dir} (${(e as NodeJS.ErrnoException).code ?? 'error'}): ${String(e)}`)
          continue
        }
        dirs.push(dir)
        for (const f of inner) if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(dir, f.name))
      }
    }
    return { files, dirs, failed }
  }

  private underProjects(p: string): boolean {
    return this.opts.projectsDirs.some((d) => isInsideRoot(p, d))
  }

  private async doScan(roots: string[], signal?: AbortSignal): Promise<ScanResult> {
    let changed = false
    let filesRead = 0
    let failed = 0
    let aborted = false
    let cacheWriteError: string | undefined
    const listed = await this.listFiles(roots)
    const { files, dirs } = listed
    failed += listed.failed
    const present = new Set(files)
    // Forget cached files that vanished from directories we just listed.
    const dirSet = new Set(dirs)
    const projNorm = this.opts.projectsDirs.map(normalizePath)
    for (const p of Object.keys(this.data.files)) {
      const parent = path.dirname(p)
      if (dirSet.has(parent) && !present.has(p)) {
        delete this.data.files[p]
        changed = true
      } else if (
        !dirSet.has(parent) &&
        projNorm.includes(normalizePath(path.dirname(parent))) &&
        dirMatchesAnyRoot(path.basename(parent), roots) &&
        !(await dirExists(parent))
      ) {
        // The whole project dir is gone.
        delete this.data.files[p]
        changed = true
      }
    }
    for (const f of files) {
      if (signal?.aborted) {
        aborted = true
        break
      }
      try {
        const r = await scanFile(f, this.data.files[f], { signal, log: this.opts.log })
        this.data.files[f] = r.state
        if (r.read) filesRead++
        if (r.changed) changed = true
        if (r.aborted) {
          aborted = true
          break
        }
      } catch (e) {
        failed++
        this.opts.log(`indexer: failed to read ${f} (${(e as NodeJS.ErrnoException).code ?? 'error'}): ${String(e)}`)
      }
    }
    if (!aborted) {
      this.data.lastIndexedAt = (this.opts.now ?? Date.now)()
    }
    if (changed) {
      this._rev++
    }
    if (changed || !aborted) {
      try {
        await writeCacheAtomic(this.opts.cacheFile, this.data)
      } catch (e) {
        cacheWriteError = String(e)
        this.opts.log(`indexer: cannot write cache: ${cacheWriteError}`)
      }
    }
    const res: ScanResult = { changed, filesRead, failed }
    if (cacheWriteError) res.cacheWriteError = cacheWriteError
    return res
  }

  query(roots: string[]): { items: Item[]; sessions: Record<string, SessionRef> } {
    const files: Record<string, FileState> = {}
    for (const [p, st] of Object.entries(this.data.files)) if (this.underProjects(p)) files[p] = st
    const merged = mergeItems(files)
    const allSessions = mergeSessions(files)
    const items: Item[] = []
    const sessions: Record<string, SessionRef> = {}
    for (const m of merged) {
      if (!m.cwds.some((c) => isInsideAnyRoot(c, roots))) continue
      items.push(m.item)
      for (const sid of m.item.sessionIds) {
        const s = allSessions[sid]
        if (s) sessions[sid] = s
      }
    }
    return { items, sessions }
  }

  async clear(): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.data = emptyCache()
      this._rev++
      try {
        await removeCache(this.opts.cacheFile)
      } catch (e) {
        this.opts.log(`indexer: cannot remove cache: ${String(e)}`)
      }
    })
    await this.chain
  }
}
