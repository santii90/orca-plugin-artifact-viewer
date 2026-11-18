#!/usr/bin/env node
// Repository checks that need no Orca install: run in CI and by scripts/release-check.mjs.
// Mirrors the orca.dev listing rules (manifest, licence, forbidden files, size and image limits).
// Usage: node scripts/check-repo.mjs [--tag vX.Y.Z]
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const fail = (msg) => errors.push(msg)

// --- manifest ---
let manifest = null
try {
  manifest = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'))
} catch (e) {
  fail(`orca-plugin.json is not valid JSON: ${e.message}`)
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
if (manifest) {
  if (manifest.manifestVersion !== 2) fail('manifestVersion must be 2')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? '')) fail('id must be kebab-case')
  if (/^orca-/.test(manifest.id ?? '')) fail('ids starting with "orca-" are reserved')
  if ('publisher' in manifest) fail('leave "publisher" out: Orca derives it from the repository owner')
  if (!SEMVER.test(manifest.version ?? '')) fail(`version "${manifest.version}" is not semver`)
  if (!manifest.license) fail('license is missing')
  if (!/^>=\d+\.\d+\.\d+$/.test(manifest.engines?.orca ?? '')) fail('engines.orca must look like ">=x.y.z"')
  for (const img of [manifest.cover, ...(manifest.screenshots ?? [])].filter(Boolean)) {
    if (!img.alt) fail(`image ${img.path} needs an alt text`)
  }
}

// --- tag matches version ---
const tagArg = process.argv.indexOf('--tag')
const tag = tagArg > 0 ? process.argv[tagArg + 1] : null
if (tag && manifest && tag !== `v${manifest.version}`) fail(`tag ${tag} does not match manifest version v${manifest.version}`)

// --- files that ship (tracked by git) ---
let files = []
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
} catch (e) {
  fail(`git ls-files failed: ${e.message}`)
}
if (!files.includes('LICENSE')) fail('LICENSE file is missing')
if (files.length > 2000) fail(`too many files: ${files.length} > 2000`)
const FORBIDDEN = /\.(exe|dll|so|dylib|node|bin|com|msi|zip|tar|gz|tgz|7z|rar|jar|ttf|otf)$/i
let total = 0
for (const f of files) {
  const abs = path.join(root, f)
  let st
  try { st = lstatSync(abs) } catch { continue } // deleted in the working tree
  if (st.isSymbolicLink()) fail(`symlinks are not allowed: ${f}`)
  if (FORBIDDEN.test(f)) fail(`binary/archive/font file not allowed: ${f}`)
  total += st.size
  if (/\.(ts|tsx|mts|jsx)$/.test(f) && st.size > 1024 * 1024) fail(`${f} exceeds 1 MiB`)
}
if (total > 50 * 1024 * 1024) fail(`repository content ${(total / 1048576).toFixed(1)} MiB exceeds 50 MiB`)

// --- listing images ---
function pngSize(file) {
  const b = readFileSync(file)
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}
function jpegSize(file) {
  const b = readFileSync(file)
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}
function checkImage(rel, { minW, minH, maxKB, square, label }) {
  const abs = path.join(root, rel)
  let st
  try { st = lstatSync(abs) } catch { return fail(`${label} ${rel} does not exist`) }
  if (!files.includes(rel.replaceAll('\\', '/'))) fail(`${label} ${rel} is not committed`)
  if (st.size > maxKB * 1024) fail(`${label} ${rel} is ${Math.round(st.size / 1024)} KB > ${maxKB} KB`)
  const dim = /\.png$/i.test(rel) ? pngSize(abs) : /\.jpe?g$/i.test(rel) ? jpegSize(abs) : null
  if (!dim) return /\.webp$/i.test(rel) ? undefined : fail(`${label} ${rel}: cannot read its size (use PNG/JPEG/WEBP)`)
  if (dim.w < minW || dim.h < minH) fail(`${label} ${rel} is ${dim.w}×${dim.h}, needs at least ${minW}×${minH}`)
  if (square && dim.w !== dim.h) fail(`${label} ${rel} must be square`)
}
if (manifest) {
  let imgBytes = 0
  const add = (rel) => { try { imgBytes += lstatSync(path.join(root, rel)).size } catch {} }
  if (manifest.icon) { checkImage(manifest.icon, { minW: 128, minH: 128, maxKB: 256, square: true, label: 'icon' }); add(manifest.icon) }
  if (manifest.cover) { checkImage(manifest.cover.path, { minW: 800, minH: 500, maxKB: 1024, label: 'cover' }); add(manifest.cover.path) }
  const shots = manifest.screenshots ?? []
  if (shots.length > 6) fail('at most 6 screenshots')
  for (const s of shots) { checkImage(s.path, { minW: 1280, minH: 800, maxKB: 1536, label: 'screenshot' }); add(s.path) }
  if (imgBytes > 8 * 1024 * 1024) fail('listing images exceed 8 MB in total')
}

// --- panel scripts parse ---
for (const f of files.filter((f) => /^panel\/.*\.js$/.test(f))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' })
  } catch (e) {
    fail(`syntax error in ${f}: ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' ')}`)
  }
}

if (errors.length) {
  console.error(`check-repo: ${errors.length} problem(s)`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`check-repo: ok (${files.length} files, ${(total / 1024).toFixed(0)} KB${tag ? `, tag ${tag}` : ''})`)
