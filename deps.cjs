'use strict'
// Quod's dependency cache (pango07/quod-action): which package manager a
// project uses, what its install depends on (the key), and what to keep.
// Shared by the action (bundled into main and post) and the node shim's
// hook (a copy next to hook.cjs), so both compute the same key.
//
// npm: node_modules itself, restored before your install step. `npm ci`
// deletes node_modules, so the hook answers `npm ci` itself when the tree
// on disk is the one an earlier `npm ci` produced from the same key (see
// hook.cjs). Only trees whose install cannot have depended on anything
// outside the key are ever saved: no install lifecycle script in your own
// package.json files, and only dependencies whose install scripts are
// known to touch nothing but their own directory.
// pnpm, yarn, bun: their download caches (the store), which the install
// verifies itself; your install step runs as always.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const VERSION = 'quod-deps-v3'

// Lifecycle scripts `npm ci` runs for the project's own packages.
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies']

// Dependencies whose install script writes only inside their own package
// directory (a platform binary fetched or checked, a native build, a
// banner), from what it reads only of itself and the platform.
const CONTAINED = new Set([
  'esbuild', 'core-js', 'core-js-pure', 'fsevents', 'unrs-resolver', 'workerd', '@swc/core', 'sharp',
  'protobufjs', '@parcel/watcher', 'bufferutil', 'utf-8-validate', 'msgpackr-extract', '@biomejs/biome',
  'es5-ext', 'better-sqlite3', 'lmdb', '@sentry/cli', 'canvas', 'nodemon', 'styled-components',
  '@tailwindcss/oxide', 'cpu-features', 'ssh2', 'iltorb', 'deasync', 'node-pty', 'keytar', 'leveldown',
  'sqlite3', 'bcrypt', 'argon2', 're2', 'farmhash', 'zeromq', 'grpc', '@grpc/grpc-js', 'oxc-resolver',
  '@rolldown/binding', 'rolldown', 'dprint', '@dprint/formatter',
])

// Of those, the ones that only fetch or check a prebuilt binary (or print):
// what they leave does not depend on the runner image's compilers and
// libraries, only on the platform. Any other install script may compile,
// so the image's exact version goes into the key.
const PREBUILT = new Set(['esbuild', 'core-js', 'core-js-pure', 'fsevents', 'unrs-resolver', 'workerd', 'es5-ext', 'protobufjs', '@biomejs/biome', 'nodemon', 'styled-components', '@sentry/cli', '@swc/core', 'oxc-resolver', '@rolldown/binding', 'rolldown', 'dprint'])
const PLATFORM_BINARY = /^@esbuild\/|^@img\/|^@swc\/core-|^@rollup\/rollup-|^@parcel\/watcher-|^@biomejs\/cli-|^@next\/swc-/

const read = (p) => {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
}
const json = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// The package manager of the project at `root`, from its lockfile (and
// `packageManager` when two lockfiles are there), or null.
function detect(root) {
  const pkg = json(path.join(root, 'package.json'))
  if (!pkg) return null
  const has = (f) => fs.existsSync(path.join(root, f))
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null
  const found = []
  if (has('package-lock.json')) found.push({ pm: 'npm', lock: 'package-lock.json' })
  else if (has('npm-shrinkwrap.json')) found.push({ pm: 'npm', lock: 'npm-shrinkwrap.json' })
  if (has('pnpm-lock.yaml')) found.push({ pm: 'pnpm', lock: 'pnpm-lock.yaml' })
  if (has('yarn.lock')) {
    const berry = has('.yarnrc.yml') || /^yarn@[2-9]/.test(pkg.packageManager ?? '')
    found.push({ pm: berry ? 'yarn-berry' : 'yarn', lock: 'yarn.lock' })
  }
  if (has('bun.lock')) found.push({ pm: 'bun', lock: 'bun.lock' })
  else if (has('bun.lockb')) found.push({ pm: 'bun', lock: 'bun.lockb' })
  if (!found.length) return null
  if (found.length > 1 && declared) {
    const m = found.find((f) => f.pm === declared || f.pm.startsWith(`${declared}-`))
    if (m) return m
  }
  return found.length === 1 ? found[0] : null
}

// The project's root: the workspace if it has one, else the one
// directory (two levels down at most) that has.
function findRoot(ws) {
  if (detect(ws)) return ws
  const hits = []
  const look = (d, depth) => {
    let ents = []
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (detect(p)) hits.push(p)
      else if (depth < 2) look(p, depth + 1)
    }
  }
  look(ws, 1)
  return hits.length === 1 ? hits[0] : null
}

// Every package.json under `root` (relative, sorted), outside
// node_modules, .git and other dot-directories.
function manifests(root) {
  const out = []
  let budget = 20000
  const walk = (rel, depth) => {
    let ents = []
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (--budget < 0) throw new Error('too many directories to list the package.json files')
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isFile() && e.name === 'package.json') out.push(r)
      else if (e.isDirectory() && depth < 10 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(r, depth + 1)
    }
  }
  walk('', 0)
  return out.sort()
}

function npmVersion(nodeBin) {
  // npm's own package.json next to node (setup-node, the runner's node).
  try {
    const real = fs.realpathSync(nodeBin)
    const p = json(path.join(path.dirname(real), '..', 'lib', 'node_modules', 'npm', 'package.json'))
    if (p?.version) return p.version
  } catch {}
  return ''
}

// The key: everything the install reads that can change what it puts on
// disk. `facts`: { node, npm } (versions).
function key(root, info, facts, env = process.env) {
  const h = crypto.createHash('sha256')
  const add = (label, v) => {
    h.update(`${label}\0`)
    h.update(v ?? '\u0001missing')
    h.update('\0')
  }
  add('v', VERSION)
  add('pm', info.pm)
  add('lock', read(path.join(root, info.lock)))
  for (const m of manifests(root)) add(`manifest ${m}`, read(path.join(root, m)))
  for (const f of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'bunfig.toml']) add(f, read(path.join(root, f)))
  add('node', facts.node)
  if (info.pm === 'npm') {
    add('npm', facts.npm)
    // npm's user and global config files (setup-node's registry-url writes
    // one): `omit`, `legacy-peer-deps`, `ignore-scripts` there change what
    // `npm ci` installs.
    const pick = (k) => env[k] ?? env[k.toLowerCase()]
    const home = env.HOME || require('node:os').homedir()
    add('userconfig', read(pick('NPM_CONFIG_USERCONFIG') || path.join(home, '.npmrc')))
    let prefix = ''
    try {
      prefix = path.dirname(path.dirname(fs.realpathSync(facts.bin)))
    } catch {}
    add('globalconfig', read(pick('NPM_CONFIG_GLOBALCONFIG') || path.join(prefix, 'etc', 'npmrc')))
  }
  add('platform', process.platform)
  add('arch', process.arch)
  add('ImageOS', env.ImageOS ?? '')
  if (info.pm === 'npm' && compiles(root, info)) add('ImageVersion', env.ImageVersion ?? '')
  add('NODE_ENV', env.NODE_ENV ?? '')
  for (const k of Object.keys(env).filter((k) => /^npm_config_/i.test(k)).sort()) add(`env ${k.toLowerCase()}`, env[k])
  return h.digest('hex').slice(0, 40)
}

// Whether any dependency's install script may compile against the image.
function compiles(root, info) {
  const lock = json(path.join(root, info.lock))
  if (!lock?.packages) return true
  for (const [p, v] of Object.entries(lock.packages)) {
    if (!v.hasInstallScript || !p.includes('node_modules/')) continue
    const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!PREBUILT.has(name) && !PLATFORM_BINARY.test(name)) return true
  }
  return false
}

// npm: the node_modules directories to keep (relative to the workspace),
// and the parts of them that are runtime caches, not the install.
function npmPaths(ws, root) {
  const rel = path.relative(ws, root)
  const dirs = manifests(root).map((m) => path.posix.dirname(m))
  const paths = [...new Set(dirs)].map((d) => path.posix.join(rel.split(path.sep).join('/') || '.', d, 'node_modules'))
  return [...paths, '!**/node_modules/.cache', '!**/node_modules/.vite', '!**/node_modules/.quod-vitest']
}

// Why a node_modules installed here must not be saved, or null. The tree
// is kept only when nothing outside the key can have gone into it.
function npmUnsafe(root) {
  for (const m of manifests(root)) {
    const s = json(path.join(root, m))?.scripts ?? {}
    const l = LIFECYCLE.find((k) => s[k])
    if (l) return `${m} has a "${l}" script`
  }
  const lock = json(path.join(root, fs.existsSync(path.join(root, 'package-lock.json')) ? 'package-lock.json' : 'npm-shrinkwrap.json'))
  if (!lock?.packages) return 'the lockfile is not v2 or v3 (no "packages")'
  for (const [p, v] of Object.entries(lock.packages)) {
    if (!v.hasInstallScript || !p.includes('node_modules/')) continue
    const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!CONTAINED.has(name) && !PLATFORM_BINARY.test(name))
      return `${name} has an install script Quod does not know to stay in its own directory`
  }
  return null
}

// `npm ci`'s arguments without the ones that change only its output.
function npmArgs(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^--(no-)?(audit|fund|progress|update-notifier|color)$/.test(a)) continue
    if (/^--(loglevel|color)=/.test(a)) continue
    if (a === '--loglevel') {
      i++
      continue
    }
    if (['--silent', '--quiet', '-s', '-q', '--prefer-offline', '--prefer-online', '--verbose', '-d', '-dd', '-ddd', '--foreground-scripts'].includes(a)) continue
    out.push(a)
  }
  return out.sort()
}

// Every file, link and directory under the kept node_modules directories
// (path, kind, size, mtime, mode), the runtime caches left out: taken when
// \`npm ci\` finishes and again before the save, so a tree anything changed
// after the install is not saved.
function fullPrint(ws, paths) {
  const h = crypto.createHash('sha256')
  const skip = new Set(['.cache', '.vite', '.quod-vitest', '.quod-deps.json'])
  const walk = (abs, rel, parentIsNm) => {
    let ents
    try {
      ents = fs.readdirSync(abs).sort()
    } catch {
      return
    }
    for (const e of ents) {
      if (parentIsNm && skip.has(e)) continue
      const p = path.join(abs, e)
      let st
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      const r = `${rel}/${e}`
      if (st.isSymbolicLink()) h.update(`l ${r} ${fs.readlinkSync(p)}\n`)
      else if (st.isDirectory()) {
        h.update(`d ${r} ${st.mode}\n`)
        walk(p, r, e === 'node_modules')
      } else h.update(`f ${r} ${st.size} ${st.mtimeMs} ${st.mode}\n`)
    }
  }
  for (const p of paths) if (!p.startsWith('!')) walk(path.join(ws, p), p, true)
  return h.digest('hex')
}

// A cheap print of the root node_modules: npm's hidden lockfile and the
// top-level entries. Taken right after Quod's restore and again at `npm ci`:
// anything that restored or installed over the tree in between (another
// cache step) changes it.
function treePrint(root) {
  const nm = path.join(root, 'node_modules')
  const h = crypto.createHash('sha256')
  h.update(read(path.join(nm, '.package-lock.json')) ?? 'none')
  let top
  try {
    top = fs.readdirSync(nm).sort()
  } catch {
    return 'none'
  }
  for (const e of top) {
    if (['.cache', '.vite', '.quod-vitest'].includes(e)) continue
    h.update(`${e}\n`)
    if (e.startsWith('@')) {
      try {
        for (const s of fs.readdirSync(path.join(nm, e)).sort()) h.update(`${e}/${s}\n`)
      } catch {}
    }
  }
  return h.digest('hex')
}

const NPM_CI = ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean']

module.exports = { VERSION, detect, findRoot, manifests, npmVersion, key, npmPaths, npmUnsafe, npmArgs, treePrint, fullPrint, NPM_CI }
