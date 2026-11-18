// Incremental, byte-offset reading of one transcript file.
import fs from 'node:fs'
import { applyLine, lineIsInteresting, newFileState } from './parse.ts'
import type { FileState } from './parse.ts'

const CHUNK_BYTES = 1024 * 1024

export type ScanFileResult = {
  state: FileState
  /** True when the state gained or lost information (events, sessions, offset). */
  changed: boolean
  /** True when any bytes were read. */
  read: boolean
  aborted: boolean
}

export async function scanFile(
  filePath: string,
  prev: FileState | undefined,
  opts: { signal?: AbortSignal; log: (msg: string) => void }
): Promise<ScanFileResult> {
  const st = await fs.promises.stat(filePath)
  let state = prev
  let changed = false
  if (state && (st.size < state.size || st.mtimeMs < state.mtimeMs)) {
    opts.log(`indexer: ${filePath} shrank or moved back in time, reparsing from 0`)
    state = undefined
    changed = true
  }
  if (!state) state = newFileState()
  if (st.size === state.size && st.mtimeMs === state.mtimeMs && state.offset > 0) {
    return { state, changed, read: false, aborted: false }
  }
  if (st.size === 0) {
    state.size = 0
    state.mtimeMs = st.mtimeMs
    return { state, changed, read: false, aborted: false }
  }

  let bad = 0
  let applyErrors = 0
  let firstApplyError = ''
  let aborted = false
  let read = false
  const fh = await fs.promises.open(filePath, 'r')
  try {
    let carry: Buffer = Buffer.alloc(0)
    let pos = state.offset // file position of the next byte to read
    const readBuf = Buffer.allocUnsafe(CHUNK_BYTES)
    while (pos < st.size) {
      if (opts.signal?.aborted) {
        aborted = true
        break
      }
      const want = Math.min(CHUNK_BYTES, st.size - pos)
      const { bytesRead } = await fh.read(readBuf, 0, want, pos)
      if (bytesRead === 0) break
      read = true
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, readBuf.subarray(0, bytesRead)]) : Buffer.from(readBuf.subarray(0, bytesRead))
      const lastNl = data.lastIndexOf(0x0a)
      if (lastNl < 0) {
        carry = data
        continue
      }
      const base = state.offset // offset of data[0]
      let start = 0
      while (start <= lastNl) {
        const nl = data.indexOf(0x0a, start)
        const lineBuf = data.subarray(start, nl)
        if (lineBuf.length > 2 && lineIsInteresting(lineBuf, state)) {
          let parsed: unknown
          let ok = false
          try {
            parsed = JSON.parse(lineBuf.toString('utf8'))
            ok = true
          } catch {
            bad++
          }
          if (ok) {
            try {
              applyLine(state, parsed, base + start)
              changed = true
            } catch (e) {
              applyErrors++
              if (applyErrors === 1) firstApplyError = `at byte ${base + start}: ${String(e)}`
            }
          }
        }
        start = nl + 1
      }
      state.offset = base + lastNl + 1
      carry = data.subarray(lastNl + 1)
      changed = true
    }
  } finally {
    await fh.close()
  }
  if (bad > 0) opts.log(`indexer: ${filePath}: skipped ${bad} unparseable line(s)`)
  if (applyErrors > 0) opts.log(`indexer: ${filePath}: ${applyErrors} line(s) failed to apply (first ${firstApplyError})`)
  if (aborted) {
    // Keep what was processed; force the next scan to look at the file again.
    state.size = state.offset
    state.mtimeMs = 0
  } else {
    state.size = st.size
    state.mtimeMs = st.mtimeMs
  }
  return { state, changed, read, aborted }
}
