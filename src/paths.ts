// Locations of the index cache and Claude's projects directories. Everything environment-specific
// is injectable so tests can run any platform's layout on any machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type PathsEnv = {
  home: string
  platform: string
  env: Record<string, string | undefined>
  exists(p: string): boolean
  /** File contents, or null when the file does not exist. Throws on any other read error. */
  readText(p: string): string | null
}

export function defaultPathsEnv(): PathsEnv {
  return {
    home: os.homedir(),
    platform: process.platform,
    env: process.env,
    exists: (p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    },
    readText: (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw e
      }
    }
  }
}

function flavor(e: PathsEnv): path.PlatformPath {
  return e.platform === 'win32' ? path.win32 : path.posix
}

export function expandHome(p: string, e: PathsEnv): string {
  if (p === '~') return e.home
  if (p.startsWith('~/') || p.startsWith('~\\')) return flavor(e).join(e.home, p.slice(2))
  return p
}

export function cacheFilePath(e: PathsEnv = defaultPathsEnv()): string {
  const p = flavor(e)
  if (e.platform === 'win32') return p.join(e.home, 'AppData', 'Local', 'orca-artifacts', 'index-v1.json')
  return p.join(e.home, '.cache', 'orca-artifacts', 'index-v1.json')
}

const warned = new Set<string>()
function warnOnce(key: string, log: ((msg: string) => void) | undefined, msg: string): void {
  if (!log || warned.has(key)) return
  warned.add(key)
  log(msg)
}

function readObservedDirs(file: string, e: PathsEnv, log?: (msg: string) => void): string[] {
  let text: string | null
  try {
    text = e.readText(file)
  } catch (err) {
    warnOnce(file, log, `claude-observed-config-dirs.json unreadable (${err instanceof Error ? err.message : String(err)}); ignoring it`)
    return []
  }
  if (text === null) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  } catch (err) {
    warnOnce(file, log, `claude-observed-config-dirs.json invalid (${err instanceof Error ? err.message : String(err)}); ignoring it`)
    return []
  }
}

function dedupe(dirs: string[], e: PathsEnv): string[] {
  const p = flavor(e)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    let key = p.normalize(d).replace(/[\\/]+$/, '')
    if (e.platform === 'win32') key = key.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

/** Claude config directories (each holds a `projects` folder). */
export function claudeDirs(setting: string | undefined, e: PathsEnv = defaultPathsEnv(), log?: (msg: string) => void): string[] {
  const p = flavor(e)
  const fromSetting = (setting ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => expandHome(l, e))
  if (fromSetting.length > 0) return dedupe(fromSetting, e)
  const out: string[] = []
  if (e.platform === 'win32') {
    out.push(...readObservedDirs(p.join(e.home, 'AppData', 'Roaming', 'orca', 'claude-observed-config-dirs.json'), e, log))
  }
  out.push(p.join(e.home, '.claude'))
  const fromEnv = e.env.CLAUDE_CONFIG_DIR?.trim()
  if (fromEnv) out.push(expandHome(fromEnv, e))
  return dedupe(out, e)
}

export type ProjectsDirsReport = {
  /** Existing `projects` folders. */
  dirs: string[]
  /** Every `projects` folder considered, existing or not. */
  looked: string[]
  /** Folders from the user's setting whose `projects` folder does not exist. */
  missingConfigured: string[]
}

/** `<claudeDir>/projects` for each Claude dir: which exist, which were looked at, which configured ones are missing. */
export function projectsDirsReport(
  setting: string | undefined,
  e: PathsEnv = defaultPathsEnv(),
  log?: (msg: string) => void
): ProjectsDirsReport {
  const p = flavor(e)
  const looked = dedupe(
    claudeDirs(setting, e, log).map((d) => p.join(d, 'projects')),
    e
  )
  const dirs = looked.filter((d) => e.exists(d))
  const configured = (setting ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const missingConfigured = configured.length > 0 ? looked.filter((d) => !dirs.includes(d)) : []
  return { dirs, looked, missingConfigured }
}

/** `<claudeDir>/projects` for each Claude dir, existing ones only. */
export function projectsDirs(setting: string | undefined, e: PathsEnv = defaultPathsEnv(), log?: (msg: string) => void): string[] {
  return projectsDirsReport(setting, e, log).dirs
}
