import { test, assert } from 'orca/testing'
import { CliError, createCliRunner, evalArgs, extractEvalObject, extractPageId, extractScreenshotPath, findCli, resolveCli, screenshotArgs, tabCreateArgs, waitFnArgs, waitLoadArgs } from './cli.ts'
import { cacheFilePath, claudeDirs, projectsDirs, projectsDirsReport, type PathsEnv } from './paths.ts'

const winExe = 'C:\\Users\\u\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'

function finderEnv(platform: string, existing: string[], PATH = '') {
  return { home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u', platform, env: { PATH }, exists: (p: string) => existing.includes(p) }
}

test('findCli: override wins, then known location, then PATH', () => {
  assert.equal(findCli('D:\\x\\orca.exe', finderEnv('win32', ['D:\\x\\orca.exe', winExe])), 'D:\\x\\orca.exe')
  assert.equal(findCli('', finderEnv('win32', [winExe])), winExe)
  assert.equal(findCli('missing', finderEnv('win32', [winExe])), winExe)
  assert.equal(findCli('', finderEnv('win32', ['C:\\bin\\orca.exe'], 'C:\\nope;C:\\bin')), 'C:\\bin\\orca.exe')
  assert.equal(
    findCli('', finderEnv('darwin', ['/Applications/Orca.app/Contents/Resources/bin/orca'])),
    '/Applications/Orca.app/Contents/Resources/bin/orca'
  )
  assert.equal(findCli('', finderEnv('linux', ['/opt/bin/orca'], '/usr/bin:/opt/bin')), '/opt/bin/orca')
  assert.equal(findCli('', finderEnv('linux', [])), null)
})

test('tabCreateArgs builds exact args and validates', () => {
  assert.deepEqual(tabCreateArgs('https://claude.ai/code/artifact/abc', 'C:/dev/app'), [
    'tab', 'create', '--url', 'https://claude.ai/code/artifact/abc', '--worktree', 'path:C:/dev/app'
  ])
  assert.deepEqual(tabCreateArgs('file:///C:/x/a.html', '/home/u/app').slice(-1), ['path:/home/u/app'])
  assert.throws(() => tabCreateArgs('http://claude.ai/x', 'C:/a'), (e) => e instanceof CliError && e.code === 'invalid_args')
  assert.throws(() => tabCreateArgs('https://evil.com/', 'C:/a'), /Refusing/)
  assert.throws(() => tabCreateArgs('https://claude.ai/a b', 'C:/a'), /Refusing/)
  assert.throws(() => tabCreateArgs('https://claude.ai/a', 'relative/path'), /absolute/)
})

type Cb = (err: any, stdout: string) => void
function stubExec(respond: (cb: Cb) => void) {
  const calls: { file: string; args: string[]; options: any }[] = []
  const killed: number[] = []
  const impl = (file: string, args: string[], options: any, cb: Cb) => {
    calls.push({ file, args, options })
    const id = calls.length
    respond(cb)
    return { kill: () => void killed.push(id) }
  }
  return { impl, calls, killed }
}
const env = { home: 'C:\\Users\\u', platform: 'win32', base: {} as Record<string, string> }

test('run: spawns the exe directly with --json, no shell, parses the envelope', async () => {
  const s = stubExec((cb) => cb(null, JSON.stringify({ id: 'x', ok: true, result: { tabs: [] } })))
  const r = createCliRunner(s.impl, env)
  assert.deepEqual(await r.run(winExe, ['tab', 'list'], 5000), { tabs: [] })
  assert.equal(s.calls[0].file, winExe)
  assert.deepEqual(s.calls[0].args, ['tab', 'list', '--json'])
  assert.equal(s.calls[0].options.shell, false)
  assert.equal(s.calls[0].options.windowsHide, true)
  assert.equal(s.calls[0].options.timeout, 5000)
  assert.equal(s.calls[0].options.env.APPDATA, 'C:\\Users\\u\\AppData\\Roaming')
  assert.equal(r.running(), 0)
})

test('run: ok=false rejects with the error message, even on nonzero exit', async () => {
  const s = stubExec((cb) => cb(new Error('exit 1'), JSON.stringify({ ok: false, error: { message: 'no worktree' } })))
  await assert.rejects(createCliRunner(s.impl, env).run(winExe, [], 1000), /no worktree/)
})

test('run: non-JSON and timeout are distinguished', async () => {
  const bad = stubExec((cb) => cb(null, 'garbage'))
  await assert.rejects(createCliRunner(bad.impl, env).run(winExe, [], 1000), /no JSON/)
  const slow = stubExec((cb) => cb(Object.assign(new Error('killed'), { killed: true }), ''))
  await assert.rejects(createCliRunner(slow.impl, env).run(winExe, [], 2000), (e) => e instanceof CliError && e.code === 'cli_timeout')
})

test('run: non-JSON failures carry the first stderr line; an unexpected JSON shape says so; the full message is logged', async () => {
  const logs: string[] = []
  const long = 'x'.repeat(300)
  const noisy = stubExec((cb) => (cb as any)(new Error('Command failed'), 'oops', `\n  boom: bad flag\nsecond line\n${long}`))
  await assert.rejects(
    createCliRunner(noisy.impl, env, (m) => logs.push(m)).run(winExe, [], 1000),
    (e) => e instanceof CliError && e.message === 'Orca CLI returned no JSON: boom: bad flag'
  )
  assert.ok(logs[0].includes('second line'))
  const longLine = stubExec((cb) => (cb as any)(null, '', long))
  await assert.rejects(createCliRunner(longLine.impl, env).run(winExe, [], 1000), (e) => e instanceof Error && e.message.length < 260)
  const shape = stubExec((cb) => cb(null, JSON.stringify({ hello: 'world' })))
  await assert.rejects(createCliRunner(shape.impl, env).run(winExe, [], 1000), /unexpected JSON shape/)
})

test('run: refuses .cmd shims with cli_invalid; killAll kills tracked children', async () => {
  const hang = stubExec(() => {})
  const r = createCliRunner(hang.impl, env)
  await assert.rejects(
    r.run('C:\\x\\orca.cmd', [], 1000),
    (e) => e instanceof CliError && e.code === 'cli_invalid' && /orca\.exe/.test(e.message)
  )
  void r.run(winExe, ['a'], 1000).catch(() => {})
  void r.run(winExe, ['b'], 1000).catch(() => {})
  assert.equal(r.running(), 2)
  r.killAll()
  assert.equal(r.running(), 0)
  assert.deepEqual(hang.killed, [1, 2])
})

// ---- paths.ts ----

function pathsEnv(platform: string, files: Record<string, string | null>, extraEnv: Record<string, string> = {}): PathsEnv {
  return {
    home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
    platform,
    env: extraEnv,
    exists: (p) => p in files,
    readText: (p) => files[p] ?? null
  }
}

test('paths: cache file per platform', () => {
  assert.equal(cacheFilePath(pathsEnv('win32', {})), 'C:\\Users\\u\\AppData\\Local\\orca-artifacts\\index-v1.json')
  assert.equal(cacheFilePath(pathsEnv('linux', {})), '/home/u/.cache/orca-artifacts/index-v1.json')
})

test('paths: setting wins, expands ~ and dedupes case-insensitively on win32', () => {
  const e = pathsEnv('win32', { 'C:\\Users\\u\\.claude\\projects': '', 'D:\\cc\\projects': '' })
  assert.deepEqual(claudeDirs('~/.claude\n  \nD:\\cc\nd:\\CC\\', e), ['C:\\Users\\u\\.claude', 'D:\\cc'])
  assert.deepEqual(projectsDirs('~/.claude\nD:\\cc\nE:\\missing', e), ['C:\\Users\\u\\.claude\\projects', 'D:\\cc\\projects'])
})

test('paths: win32 auto = observed dirs + ~/.claude, deduped; bad JSON ignored', () => {
  const obs = 'C:\\Users\\u\\AppData\\Roaming\\orca\\claude-observed-config-dirs.json'
  const e = pathsEnv('win32', { [obs]: JSON.stringify(['D:\\acct2', 'c:\\users\\u\\.claude', 7]) })
  assert.deepEqual(claudeDirs('', e), ['D:\\acct2', 'c:\\users\\u\\.claude'])
  assert.deepEqual(claudeDirs('', pathsEnv('win32', { [obs]: '{oops' })), ['C:\\Users\\u\\.claude'])
})

test('paths: posix auto = ~/.claude plus CLAUDE_CONFIG_DIR; only existing projects dirs', () => {
  const e = pathsEnv('linux', { '/home/u/.claude/projects': '' }, { CLAUDE_CONFIG_DIR: '~/alt' })
  assert.deepEqual(claudeDirs(undefined, e), ['/home/u/.claude', '/home/u/alt'])
  assert.deepEqual(projectsDirs('', e), ['/home/u/.claude/projects'])
})

test('resolveCli: configured path must exist (no silent fallback); .cmd/.bat is cli_invalid; blank auto-discovers', () => {
  const e = finderEnv('win32', ['D:\\x\\orca.exe', winExe])
  assert.equal(resolveCli('D:\\x\\orca.exe', e), 'D:\\x\\orca.exe')
  assert.equal(resolveCli('  ', e), winExe)
  assert.throws(
    () => resolveCli('D:\\gone\\orca.exe', e),
    (err) => err instanceof CliError && err.code === 'cli_not_found' && err.message === 'Configured Orca CLI path does not exist: D:\\gone\\orca.exe'
  )
  assert.throws(() => resolveCli('D:\\x\\orca.cmd', e), (err) => err instanceof CliError && err.code === 'cli_invalid')
  assert.throws(() => resolveCli('C:\\a.BAT', e), (err) => err instanceof CliError && err.code === 'cli_invalid')
  assert.equal(resolveCli('', finderEnv('linux', [])), null)
})

test('paths: an invalid observed-dirs file is logged once, a missing one never', () => {
  const obs = 'C:\\Users\\u\\AppData\\Roaming\\orca\\claude-observed-config-dirs.json'
  const logs: string[] = []
  const bad = pathsEnv('win32', { [obs]: '{oops' })
  claudeDirs('', bad, (m) => logs.push(m))
  claudeDirs('', bad, (m) => logs.push(m))
  assert.equal(logs.length, 1)
  const quiet: string[] = []
  claudeDirs('', pathsEnv('win32', {}), (m) => quiet.push(m))
  assert.equal(quiet.length, 0)
})

test('paths: projectsDirsReport names configured folders that are missing', () => {
  const e = pathsEnv('linux', { '/a/projects': '' })
  const r = projectsDirsReport('/a\n/b', e)
  assert.deepEqual(r.dirs, ['/a/projects'])
  assert.deepEqual(r.looked, ['/a/projects', '/b/projects'])
  assert.deepEqual(r.missingConfigured, ['/b/projects'])
  assert.deepEqual(projectsDirsReport('', pathsEnv('linux', {})).missingConfigured, [])
})

test('capture arg builders validate the page id and build exact args', () => {
  assert.deepEqual(waitLoadArgs('p-1', 15000), ['wait', '--page', 'p-1', '--load', 'load', '--timeout', '15000'])
  assert.deepEqual(waitFnArgs('p-1', 'x', 10000), ['wait', '--page', 'p-1', '--fn', 'x', '--timeout', '10000'])
  assert.deepEqual(evalArgs('p-1', '1+1'), ['eval', '--page', 'p-1', '--expression', '1+1'])
  assert.deepEqual(screenshotArgs('p-1'), ['screenshot', '--page', 'p-1', '--format', 'jpeg'])
  for (const bad of ['', 'a b', 'a;b', '--x y', '../a']) assert.throws(() => screenshotArgs(bad), /Invalid browser page id/)
})

test('result extractors tolerate wrapped shapes', () => {
  assert.equal(extractPageId({ browserPageId: 'abc-1' }), 'abc-1')
  assert.equal(extractPageId({ tab: { browserPageId: 'abc-1' } }), 'abc-1')
  assert.equal(extractPageId({ browserPageId: 'a b' }), null)
  assert.equal(extractPageId({}), null)
  assert.equal(extractScreenshotPath({ path: 'C:\\t\\a.jpg' }), 'C:\\t\\a.jpg')
  assert.equal(extractScreenshotPath({}), null)
  assert.deepEqual(extractEvalObject('{"path":"/a","r":null}'), { path: '/a', r: null })
  assert.deepEqual(extractEvalObject({ result: { value: '{"path":"/a"}' } }), { path: '/a' })
  assert.equal(extractEvalObject({ value: 'oops' }), null)
})

test('extractors accept the real orca --json shapes', () => {
  // After the envelope: tab create -> { browserPageId }, screenshot -> { path }, eval -> { result: "<JSON string>" }.
  assert.equal(extractPageId({ browserPageId: 'abc-1', url: 'https://claude.ai/' }), 'abc-1')
  assert.equal(extractScreenshotPath({ path: 'C:/Temp/orca-browser-screenshots/u-screenshot.jpg' }), 'C:/Temp/orca-browser-screenshots/u-screenshot.jpg')
  assert.deepEqual(extractEvalObject({ result: JSON.stringify({ path: '/artifact/a', r: null }) }), { path: '/artifact/a', r: null })
  assert.deepEqual(extractEvalObject({ result: JSON.stringify({ path: '/artifact/a', r: { x: 0, y: 45, width: 8, height: 9 } }) }), {
    path: '/artifact/a', r: { x: 0, y: 45, width: 8, height: 9 }
  })
  assert.equal(extractEvalObject({ result: 'undefined' }), null)
})

test('createCliRunner unwraps the real envelope for tab create, eval and screenshot', async () => {
  const outputs: Record<string, string> = {
    tab: '{"ok":true,"result":{"browserPageId":"page-7"}}',
    eval: '{"ok":true,"result":{"result":"{\\"path\\":\\"/a\\",\\"r\\":null}"}}',
    screenshot: '{"ok":true,"result":{"path":"C:/Temp/orca-browser-screenshots/u.jpg"}}'
  }
  const runner = createCliRunner(
    (_file, args, _opts, cb) => {
      cb(null, outputs[args[0]], '')
      return { kill() {} }
    },
    { home: '/h', platform: 'linux', base: {} }
  )
  assert.equal(extractPageId(await runner.run('/bin/orca', ['tab', 'create'], 1000)), 'page-7')
  assert.deepEqual(extractEvalObject(await runner.run('/bin/orca', evalArgs('p', '1'), 1000)), { path: '/a', r: null })
  assert.equal(extractScreenshotPath(await runner.run('/bin/orca', screenshotArgs('p'), 1000)), 'C:/Temp/orca-browser-screenshots/u.jpg')
})
