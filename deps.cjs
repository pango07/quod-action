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
const installProfile = require('./npm-install-profile.cjs')

const VERSION = 'quod-deps-v4'

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

// One selector for the npmrc files hashed by the key and inspected by all
// three admission points. The saved Node path is setup-node's, not the
// potentially different Node that runs the Action's post bundle.
function npmInstallation(nodeBin) {
  const prefix = path.dirname(path.dirname(fs.realpathSync(nodeBin)))
  const root = fs.realpathSync(path.join(prefix, 'lib', 'node_modules', 'npm'))
  return {prefix, root, cli: fs.realpathSync(path.join(root, 'bin', 'npm-cli.js'))}
}

function npmConfigFiles(root, facts = {bin: process.execPath}, env = process.env) {
  const npm = npmInstallation(facts.bin)
  const pick = name => {
    const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : env[key]
  }
  const home = env.HOME || require('node:os').homedir()
  return [['.npmrc', path.join(root, '.npmrc')],
    ['userconfig', pick('NPM_CONFIG_USERCONFIG') || path.join(home, '.npmrc')],
    ['globalconfig', pick('NPM_CONFIG_GLOBALCONFIG') || path.join(npm.prefix, 'etc', 'npmrc')],
    ['builtinconfig', path.join(npm.root, 'npmrc')]]
}

// The key: everything the install reads that can change what it puts on
// disk. `facts`: { node, npm } (versions).
function key(root, info, facts, env = process.env, requestedProfile = null) {
  if (info.pm === 'npm') {
    const unsafe = npmInstallUnsafe(root, info, facts, env)
    // The npm hook catches this before it can answer for `npm ci`. A new
    // implicit install input after restore must run npm, not mint a key.
    if (unsafe) throw new Error(`npm dependency reuse declined: ${unsafe}`)
  }
  const h = crypto.createHash('sha256')
  const add = (label, v) => {
    h.update(`${label}\0`)
    h.update(v ?? '\u0001missing')
    h.update('\0')
  }
  add('v', VERSION)
  const names = manifests(root)
  const profile = installProfile.project(root, info, requestedProfile, names)
  if (profile) add('install-profile', profile.id)
  add('pm', info.pm)
  // Old npm entries may have been installed with an unkeyed binding.gyp or
  // overriding shrinkwrap. Do not reuse them even after that input is gone.
  if (info.pm === 'npm') add('npm-install-policy', 'closed-root-install-inputs-v1')
  add('lock', unversioned(path.join(root, info.lock), info.lock))
  if (profile) add('manifest package.json', profile.manifest)
  else for (const m of names) add(`manifest ${m}`, unversioned(path.join(root, m), m))
  for (const f of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'bunfig.toml']) add(f, read(path.join(root, f)))
  add('node', facts.node)
  if (info.pm === 'npm') {
    add('npm', facts.npm)
    // Bind admitted blank/comment-only user, global and builtin config.
    // Significant config or semantic npm environment is declined above.
    for (const [label, file] of npmConfigFiles(root, facts, env).slice(1)) add(label, read(file))
  }
  add('platform', process.platform)
  add('arch', process.arch)
  add('ImageOS', env.ImageOS ?? '')
  if (info.pm === 'npm' && compiles(root, info)) add('ImageVersion', env.ImageVersion ?? '')
  add('NODE_ENV', env.NODE_ENV ?? '')
  for (const k of Object.keys(env).filter((k) => /^npm_config_/i.test(k)).sort()) add(`env ${k.toLowerCase()}`, env[k])
  return h.digest('hex').slice(0, 40)
}

// A manifest or npm lockfile without the project's own version (and the
// lockfile's root entry's): a release bump installs the same tree. npm
// writes that version only into node_modules/.package-lock.json's header,
// which the shim brings up to date when it answers \`npm ci\` (hook.cjs). Any
// other file, or one that does not parse, is taken whole.
function unversioned(p, name) {
  const raw = read(p)
  if (raw == null) return null
  const base = path.basename(name)
  if (base !== 'package.json' && base !== 'package-lock.json' && base !== 'npm-shrinkwrap.json') return raw
  let j
  try {
    j = JSON.parse(raw.toString('utf8'))
  } catch {
    return raw
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return raw
  delete j.version
  if (base !== 'package.json' && j.packages?.['']) delete j.packages[''].version
  return JSON.stringify(j)
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

// What tools write into node_modules as they run (caches, vitest's and
// vite's state, Quod's driver): not the install, never saved or compared.
const RUNTIME = ['.cache', '.vite', '.vite-temp', '.vitest', '.quod-vitest']

// npm: the node_modules directories to keep (relative to the workspace),
// and the parts of them that are runtime caches, not the install.
function npmPaths(ws, root, requestedProfile = null) {
  const rel = path.relative(ws, root)
  const names = manifests(root)
  const profile = installProfile.project(root, {pm: 'npm', lock: 'package-lock.json'}, requestedProfile, names)
  const dirs = (profile ? ['package.json'] : names).map((m) => path.posix.dirname(m))
  const paths = [...new Set(dirs)].map((d) => path.posix.join(rel.split(path.sep).join('/') || '.', d, 'node_modules'))
  return [...paths, ...RUNTIME.map((d) => `!**/node_modules/${d}`)]
}

// Why a node_modules installed here must not be saved, or null. The tree
// is kept only when nothing outside the key can have gone into it.
function npmUnsafe(root, facts, env) {
  const implicit = npmInstallUnsafe(root, undefined, facts, env)
  if (implicit) return implicit
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

// Inputs the current npm tree key cannot close. Check before restore, again
// when the hook would skip npm, and before post saves a fresh installation.
// Workspaces/local links deliberately run native: the manifest walker is
// not an npm workspace/glob or external source resolver.
function npmInstallUnsafe(root, info, facts, env = process.env) {
  const present = name => {
    try { return fs.lstatSync(path.join(root, name)) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  if (present('binding.gyp')) return 'root binding.gyp can add an implicit install'
  const packageLock = present('package-lock.json'), shrinkwrap = present('npm-shrinkwrap.json')
  if (packageLock && shrinkwrap) return 'npm-shrinkwrap.json overrides package-lock.json'
  const lockName = packageLock ? 'package-lock.json' : 'npm-shrinkwrap.json'
  const lockStat = packageLock || shrinkwrap
  if (!lockStat?.isFile() || (info && info.lock !== lockName)) return 'npm lockfile selection is not a regular current input'
  const manifest = present('package.json')
  if (!manifest?.isFile()) return 'package.json is not a regular install input'
  const pkg = json(path.join(root, 'package.json')), lock = json(path.join(root, lockName))
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(pkg) || !object(lock?.packages)) return 'npm install manifests are unreadable or unsupported'
  if (Object.hasOwn(pkg, 'workspaces') || Object.hasOwn(lock.packages[''] || {}, 'workspaces')) return 'npm workspaces require native installation'
  const local = (value, resolved = false) => {
    if (typeof value !== 'string') return false
    const text = value.trim()
    if (resolved && /^https?:\/\//i.test(text)) return false
    return /^(?:file:|git\+file:|link:|workspace:|\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/i.test(text) ||
      /\.(?:tgz|tar|tar\.gz)(?:[?#].*)?$/i.test(text) || /^[^:]*[\\/][^:]*[\\/]/.test(text)
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = pkg[field]
    if (declared !== undefined && !object(declared)) return `${field} is not an ordinary dependency map`
    if (Object.values(declared || {}).some(value => local(value))) return 'local or linked npm dependencies require native installation'
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!object(entry)) return 'npm lockfile package entries are unsupported'
    if ((name && !name.split('/').includes('node_modules')) || entry.link || local(entry.resolved, true)) return 'npm workspace or local lockfile entries require native installation'
  }
  if (Object.keys(env).some(name => /^(?:PREFIX|DESTDIR|npm_config_(?:prefix|global|location))$/i.test(name))) return 'npm prefix or global installation configuration requires native installation'
  if (env.ESBUILD_BINARY_PATH) return 'ESBUILD_BINARY_PATH can change install-script outputs'
  const environment = npmEnvironmentUnsafe(env)
  if (environment) return environment
  // npmrc loads a precedence chain and expands environment/redirects:
  // https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/#files
  // Do not implement a partial INI/nopt interpreter. Only empty/comments
  // config is admitted; even escaped interpolation declines conservatively.
  for (const [label, file] of npmConfigFiles(root, facts, env)) {
    let contents
    try { contents = fs.readFileSync(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (contents.includes('${')) return `${label} contains npm environment interpolation`
    if (contents.toString('utf8').split('\n').some(line => !/^[ \t\r]*(?:[#;].*)?$/.test(line))) return `${label} contains npm configuration that requires native installation`
  }
  return null
}

function npmEnvironmentUnsafe(env) {
  const seen = new Set()
  for (const [name, value] of Object.entries(env)) {
    const match = /^npm_config_(.+)$/i.exec(name)
    if (!match) continue
    const config = match[1].toLowerCase().replace(/_/g, '-')
    if (seen.has(config)) return 'duplicate npm environment configuration requires native installation'
    seen.add(config)
    if (typeof value !== 'string' || value.includes('${')) return 'npm environment interpolation requires native installation'
    if (['userconfig', 'globalconfig'].includes(config)) {
      if (!path.isAbsolute(value)) return 'relative npm configuration paths require native installation'
      continue
    }
    if (['audit', 'fund', 'progress', 'update-notifier'].includes(config) && ['true', 'false'].includes(value)) continue
    if (config === 'color' && ['true', 'false', 'always'].includes(value)) continue
    if (config === 'loglevel' && ['silent', 'error', 'warn', 'notice', 'http', 'info', 'verbose', 'silly'].includes(value)) continue
    return 'npm environment configuration requires native installation'
  }
  return null
}

function npmCliMatches(nodeBin, entry) {
  return npmInstallation(nodeBin).cli === fs.realpathSync(entry)
}

// nopt accepts aliases, prefixes and order-sensitive semantic arguments.
// Only exact output flags are admitted; every other form runs real npm.
function npmCiOutputOnly(args) {
  const flags = new Set(['--audit', '--no-audit', '--fund', '--no-fund', '--progress', '--no-progress',
    '--update-notifier', '--no-update-notifier', '--color', '--no-color', '--silent', '--quiet',
    '-s', '-q', '--verbose', '-d', '-dd', '-ddd'])
  const levels = new Set(['silent', 'error', 'warn', 'notice', 'http', 'info', 'verbose', 'silly'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (flags.has(arg)) continue
    if (arg === '--loglevel' && levels.has(args[i + 1])) { i++; continue }
    if (typeof arg === 'string' && arg.startsWith('--loglevel=') && levels.has(arg.slice(11))) continue
    if (['--color=true', '--color=false', '--color=always'].includes(arg)) continue
    return false
  }
  return true
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
  const skip = new Set([...RUNTIME, '.quod-deps.json'])
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
    if (RUNTIME.includes(e)) continue
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

function selectInstallProfile(root, info, managedMode) {
  if (!['v0', 'control', 'matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control'].includes(managedMode)) return null
  return installProfile.select(root, info, managedMode, manifests(root))
}

module.exports = { VERSION, detect, findRoot, manifests, npmVersion, key, npmPaths, npmUnsafe, npmInstallUnsafe, npmCliMatches, npmCiOutputOnly, npmArgs, treePrint, fullPrint, NPM_CI, selectInstallProfile }
