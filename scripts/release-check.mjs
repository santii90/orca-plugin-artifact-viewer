#!/usr/bin/env node
// Full pre-release gate. Run locally (it needs the Orca CLI) before pushing a version tag:
//   node scripts/release-check.mjs
// Checks: clean committed tree, tag not taken, repo/listing rules, `orca plugin validate`,
// `orca plugin test` and a TypeScript typecheck of src/ (TypeScript 5 via npx).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const version = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8')).version
const tag = `v${version}`

function step(name, cmd, args, opts = {}) {
  process.stdout.write(`\n▶ ${name}\n`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win && opts.shell, ...opts })
  if (r.status !== 0) {
    console.error(`\n✖ ${name} failed${r.error ? `: ${r.error.message}` : ''}`)
    process.exit(1)
  }
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

if (git('status', '--porcelain')) {
  console.error('✖ uncommitted changes: commit them first (Orca hashes the committed tree)')
  process.exit(1)
}
if (git('tag', '--list', tag)) {
  console.error(`✖ tag ${tag} already exists: bump "version" in orca-plugin.json (released versions are immutable)`)
  process.exit(1)
}

step('repo and listing checks', process.execPath, ['scripts/check-repo.mjs', '--tag', tag])
step('orca plugin validate', 'orca', ['plugin', 'validate', '.'], { shell: true })
step('orca plugin test', 'orca', ['plugin', 'test', '.'], { shell: true })
step('orca plugin types', 'orca', ['plugin', 'types', '.'], { shell: true })

// Typecheck against the typings `orca plugin types` wrote to .orca/types, plus @types/node.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'av-tsc-'))
try {
  step('install TypeScript 5 for the typecheck', 'npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', tmp, 'typescript@5.9.3', '@types/node@22'], { shell: true })
  const cfg = path.join(root, 'tsconfig.release-check.json')
  writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: {
      typeRoots: ['./.orca/types', path.join(tmp, 'node_modules', '@types').replaceAll('\\', '/')],
      types: ['orca', 'orca-host', 'orca-frame', 'orca-worker', 'orca-services', 'orca-testing', 'node']
    },
    include: ['src']
  }))
  try {
    step('typecheck', process.execPath, [path.join(tmp, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg])
  } finally {
    rmSync(cfg, { force: true })
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n✔ ready to release ${tag}:\n  git tag ${tag} && git push origin ${tag}`)
