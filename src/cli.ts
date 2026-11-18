// Runs the Orca CLI. The plugin worker's environment is minimal (no APPDATA on Windows), so the
// CLI is located by well-known paths and spawned directly: no shell, no .cmd shims.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type CliFinderEnv = {
  home: string
  platform: string
  env: Record<string, string | undefined>
  exists(p: string): boolean
}

export function defaultFinderEnv(): CliFinderEnv {
  return { home: os.homedir(), platform: process.platform, env: process.env, exists: (p) => existsSync(p) }
}

export class CliError extends Error {
  code: 'cli_not_found' | 'cli_failed' | 'cli_timeout' | 'cli_invalid' | 'invalid_args'
  constructor(code: CliError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** Absolute path of the Orca CLI executable, or null. */
export function findCli(override: string | undefined, e: CliFinderEnv = defaultFinderEnv()): string | null {
  const given = (override ?? '').trim()
  if (given && e.exists(given)) return given
  const known =
    e.platform === 'win32'
      ? path.win32.join(e.home, 'AppData', 'Local', 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
      : e.platform === 'darwin'
        ? '/Applications/Orca.app/Contents/Resources/bin/orca'
        : null
  if (known && e.exists(known)) return known
  const win = e.platform === 'win32'
  const p = win ? path.win32 : path.posix
  const dirs = String(e.env.PATH ?? e.env.Path ?? '')
    .split(win ? ';' : ':')
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = p.join(dir, win ? 'orca.exe' : 'orca')
    if (e.exists(candidate)) return candidate
  }
  return null
}

/**
 * Resolves the CLI to run. A configured path that does not exist is an error (no silent fallback);
 * a `.cmd/.bat` path is `cli_invalid`; null means auto-discovery found nothing.
 */
export function resolveCli(override: string | undefined, e: CliFinderEnv = defaultFinderEnv()): string | null {
  const given = (override ?? '').trim()
  if (given) {
    if (/\.(cmd|bat)$/i.test(given)) throw new CliError('cli_invalid', 'The CLI path must point to orca.exe, not a .cmd shim')
    if (!e.exists(given)) throw new CliError('cli_not_found', `Configured Orca CLI path does not exist: ${given}`)
    return given
  }
  return findCli('', e)
}

const SAFE_URL = /^(https:\/\/claude\.ai\/|file:\/\/\/)/

/** Args for `orca tab create`; throws CliError('invalid_args') on a URL or path we will not pass. */
export function tabCreateArgs(url: string, worktreePath: string): string[] {
  if (typeof url !== 'string' || !SAFE_URL.test(url) || /[\s\u0000-\u001f]/.test(url)) {
    throw new CliError('invalid_args', 'Refusing to open a URL that is not https://claude.ai/... or file:///...')
  }
  if (typeof worktreePath !== 'string' || !(path.win32.isAbsolute(worktreePath) || path.posix.isAbsolute(worktreePath))) {
    throw new CliError('invalid_args', 'Worktree path must be absolute')
  }
  return ['tab', 'create', '--url', url, '--worktree', `path:${worktreePath}`]
}

function childEnv(base: Record<string, string | undefined>, platform: string, home: string): NodeJS.ProcessEnv {
  const env = { ...base } as NodeJS.ProcessEnv
  if (platform === 'win32') {
    env.USERPROFILE ??= home
    env.APPDATA ??= path.win32.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= path.win32.join(home, 'AppData', 'Local')
    env.SystemRoot ??= env.SYSTEMROOT ?? 'C:\\Windows'
  }
  return env
}

type ExecFileFn = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: (
    err: (Error & { killed?: boolean; signal?: string | null }) | null,
    stdout: string | Buffer,
    stderr?: string | Buffer
  ) => void
) => { kill(signal?: string): unknown }

export type CliRunner = {
  run(cliPath: string, args: string[], timeoutMs: number): Promise<unknown>
  killAll(): void
  running(): number
}

export function createCliRunner(
  execFileImpl: ExecFileFn = execFile as unknown as ExecFileFn,
  env: { home: string; platform: string; base: Record<string, string | undefined> } = {
    home: os.homedir(),
    platform: process.platform,
    base: process.env
  },
  log: (msg: string) => void = () => {}
): CliRunner {
  const children = new Set<{ kill(signal?: string): unknown }>()
  const childEnvVars = childEnv(env.base, env.platform, env.home)
  return {
    running: () => children.size,
    killAll() {
      for (const c of children) {
        try {
          c.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      children.clear()
    },
    run(cliPath, args, timeoutMs) {
      if (/\.(cmd|bat)$/i.test(cliPath)) {
        return Promise.reject(new CliError('cli_invalid', 'The CLI path must point to orca.exe, not a .cmd shim'))
      }
      return new Promise((resolve, reject) => {
        let settled = false
        let child: { kill(signal?: string): unknown } | undefined
        child = execFileImpl(
          cliPath,
          [...args, '--json'],
          { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true, shell: false, env: childEnvVars },
          (err, stdout, stderr) => {
            settled = true
            if (child) children.delete(child)
            type Envelope = { ok?: boolean; result?: unknown; error?: { message?: string } | string }
            let parsed: Envelope | null = null
            try {
              const v: unknown = JSON.parse(String(stdout))
              if (v && typeof v === 'object') parsed = v as Envelope
            } catch {
              // not JSON
            }
            if (parsed && parsed.ok === true) return resolve(parsed.result)
            if (!parsed && err && (err.killed || err.signal)) {
              return reject(new CliError('cli_timeout', `Orca CLI timed out after ${Math.round(timeoutMs / 1000)}s`))
            }
            const fail = (message: string, full?: string): void => {
              log(`cli failed: ${full ?? message}`)
              reject(new CliError('cli_failed', message))
            }
            if (parsed) {
              const apiError = parsed.error
              const message = typeof apiError === 'string' ? apiError : apiError?.message
              if (message) return fail(message)
              if (parsed.ok === false) return fail('Orca CLI reported a failure without a message')
              return fail('Orca CLI returned an unexpected JSON shape', `unexpected JSON shape: ${String(stdout).slice(0, 500)}`)
            }
            const errText = String(stderr ?? '')
            const firstLine = errText.split(/\r?\n/).find((l) => l.trim() !== '')?.trim().slice(0, 200)
            const reason = firstLine || err?.message?.split(/\r?\n/)[0]?.slice(0, 200)
            fail(
              `Orca CLI returned no JSON${reason ? `: ${reason}` : ''}`,
              `no JSON; stderr=${errText.slice(0, 1000)}; err=${err?.message ?? '-'}`
            )
          }
        )
        if (!settled) children.add(child)
      })
    }
  }
}
