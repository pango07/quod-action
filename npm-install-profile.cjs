'use strict'
// A finite npm-ci install equivalence, used only by explicit managed modes.
// These exact public convex-helpers inputs were reviewed for the original
// twelve-commit window. This is not build, module-resolution or test authority:
// those consumers must still observe the complete package.json and sources.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ID = 'convex-helpers-original12-npm-install-v1'
const NESTED = 'packages/convex-helpers/package.json'
const NESTED_SHA = 'beec147d1e3dd62fabf9f6d1e2f64861ca89bfbba22ccd7198814ea28bd0c340'
const FIRST_LOCK = '1676eef6d2611918c8933903c475479f8df8aa63844780d2e3091688dda776c6'
const REVIEWED = new Set([
  // Root manifest, lockfile, and nonworkspace manifest presence, in that order.
  `970d98ebb0fbd32fd59ea7e5310b60489d7f78fb0e31d6960c99e804a6c0e1a6:${FIRST_LOCK}:${NESTED_SHA}`, // c0,c1
  `6f989749970c30db06920dda63d8862573621d26140fce6ba1a93395dafe893d:${FIRST_LOCK}:${NESTED_SHA}`, // c2
  `bc6d0845e54f80e78158f8c1843f6d2af5c729d8747ca8400f665d2517e0e749:${FIRST_LOCK}:${NESTED_SHA}`, // c3
  `238ecccd794e5adc119a9a48d150d0f1598854a505d398645a1c02673e3c0b20:${FIRST_LOCK}:${NESTED_SHA}`, // c4
  `238ecccd794e5adc119a9a48d150d0f1598854a505d398645a1c02673e3c0b20:${FIRST_LOCK}:`, // c5
  'bc31adf44eb03c5fabc622d0461ba9ae31bc6e5282b88133e3f60dd211c0ddb7:9d08aca826028a4888364e6df31c45ab820816f41a195fffea063ddf56b6df0f:', // c6-c9
  'f3a7d9519b58622ac5f803197923f47783f7539a750faa6d2681d643cea01275:abe6d7c318948a0de0207319dda1349a387132dc5d544476161d91643934222e:', // c10
  'd860d2a7293ed42763e15a1571e3813be4e2d4c722a1e609585d185099e64603:ec3725fcc85ddd94e708c3fdb2771825b9db30afe77bd2b0f993ea7fe6f26ae1:', // c11
])
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function regular(root, name) {
  const p = path.join(root, name)
  if (!fs.lstatSync(p).isFile()) throw new Error('nonregular install input')
  return fs.readFileSync(p)
}
function absent(root, name) {
  try { fs.lstatSync(path.join(root, name)); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
function local(value) {
  if (typeof value === 'string') return /^(?:file:|link:|workspace:|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|~[\\/])/i.test(value)
  if (Array.isArray(value)) return value.some(local)
  return object(value) && Object.values(value).some(local)
}
function safeManifest(pkg) {
  if (!object(pkg) || own(pkg, 'workspaces') || pkg.gypfile) return false
  if (own(pkg, 'scripts') && !object(pkg.scripts)) return false
  if (LIFECYCLE.some(name => own(pkg.scripts ?? {}, name))) return false
  return !DEPENDENCY_FIELDS.some(name => local(pkg[name]))
}
function safeLock(lock) {
  if (!object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages) || !object(lock.packages[''])) return false
  return Object.entries(lock.packages).every(([name, pkg]) =>
    (name === '' || name.startsWith('node_modules/')) && object(pkg) &&
    !own(pkg, 'workspaces') && !pkg.link && !local(pkg.resolved) &&
    !DEPENDENCY_FIELDS.some(field => local(pkg[field])))
}

// Unknown bytes, package/lock pairings, manifest rosters or structural inputs
// decline to the old key. The caller supplies deps.cjs's current manifest scan.
function project(root, info, requested, manifests) {
  if (requested !== ID || info?.pm !== 'npm' || info.lock !== 'package-lock.json') return null
  try {
    if (!Array.isArray(manifests) || (manifests.length !== 1 && manifests.length !== 2) || manifests[0] !== 'package.json') return null
    if (manifests.length === 2 && manifests[1] !== NESTED) return null
    // npm's implicit node-gyp install and higher-priority lockfile are outside
    // this finite profile, even when package.json itself has no lifecycle hook.
    if (!absent(root, 'binding.gyp') || !absent(root, 'npm-shrinkwrap.json')) return null
    const raw = regular(root, 'package.json'), lockRaw = regular(root, info.lock)
    const nestedRaw = manifests.length === 2 ? regular(root, NESTED) : null
    if (!REVIEWED.has(`${sha(raw)}:${sha(lockRaw)}:${nestedRaw ? sha(nestedRaw) : ''}`)) return null
    const pkg = JSON.parse(raw), lock = JSON.parse(lockRaw)
    if (!safeManifest(pkg) || !safeLock(lock) || (nestedRaw && !safeManifest(JSON.parse(nestedRaw)))) return null
    // npm ci neither runs these non-install scripts nor installs the root's
    // exports. The exact bytes above bound this omission to the reviewed set.
    delete pkg.version
    delete pkg.exports
    delete pkg.scripts
    return {id: ID, manifest: JSON.stringify(pkg)}
  } catch { return null }
}

function select(root, info, mode, manifests) {
  return ['v0', 'control', 'matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control'].includes(mode) && project(root, info, ID, manifests) ? ID : null
}

module.exports = {ID, select, project}
