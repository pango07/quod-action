'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const vm = require('node:vm')
const D = require('../deps.cjs')
const P = require('../npm-install-profile.cjs')
const legacy = require('../test/fixtures/deps-v4.cjs')
const window = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../test/fixtures/npm-install-window.json.gz'))))
const info = {pm: 'npm', lock: 'package-lock.json'}
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')
const npmCi = hook.slice(hook.indexOf('function npmCi('), hook.indexOf('\n// `npm run <script>`'))

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-install-profile-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project')
  const env = {HOME: base, ImageOS: 'ubuntu24', ImageVersion: 'fixture-image',
    NPM_CONFIG_USERCONFIG: path.join(base, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(base, 'global.npmrc')}
  const facts = {node: process.version, npm: 'fixture-npm-version', bin: process.execPath}
  function write(i) {
    fs.rmSync(root, {recursive: true, force: true})
    for (const [name, digest] of Object.entries(window.commits[i].files)) {
      const text = window.blobs[digest]
      assert.equal(hash(text), digest, `trusted fixture bytes ${name}`)
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, text)
    }
  }
  const profile = (mode = 'v0') => D.selectInstallProfile(root, info, mode)
  const key = (requested = profile(), e = env, f = facts) => D.key(root, info, f, e, requested)
  return {base, root, env, facts, write, profile, key}
}
function changePackage(root, update) {
  const file = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(file))
  update(pkg)
  fs.writeFileSync(file, JSON.stringify(pkg))
}

test('the actual twelve source inputs admit ten equivalent installs and two dependency changes', t => {
  assert.equal(window.schema, 'quod-npm-install-reviewed-window-v1')
  assert.equal(window.commits.length, 12)
  const f = fixture(t), keys = [], old = [], paths = [], raw = []
  for (let i = 0; i < 12; i++) {
    f.write(i)
    const before = fs.readFileSync(path.join(f.root, 'package.json'))
    assert.equal(f.profile(), P.ID, `c${i}`)
    assert.equal(f.profile('control'), P.ID, `control c${i}`)
    assert.equal(f.profile('matrix-research'), P.ID, `matrix research c${i}`)
    assert.equal(f.profile('matrix-control'), P.ID, `matrix control c${i}`)
    keys.push(f.key())
    old.push(legacy.key(f.root, info, f.facts, f.env))
    paths.push(D.npmPaths(f.root, f.root, f.profile()))
    raw.push(hash(before))
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'package.json')), before, 'install projection never rewrites compiler/build/test input')
  }
  assert.equal(new Set(keys.slice(0, 10)).size, 1)
  assert.equal(new Set([keys[0], keys[10], keys[11]]).size, 3)
  assert.notEqual(old[1], old[2], 'the old key missed for new release scripts')
  assert.notEqual(old[3], old[4], 'the old key missed for exports')
  assert.notEqual(old[4], old[5], 'the old key missed for nonworkspace manifest deletion')
  assert.notEqual(raw[3], raw[4], 'the complete exports input remains different')
  for (const value of paths) assert.deepEqual(value, paths[0], 'cache path versions share the same root install scope')
  assert.deepEqual(paths[0].filter(p => !p.startsWith('!')), ['node_modules'])
})

test('default-off keys and paths remain byte-compatible with deps v4 for all twelve inputs', t => {
  const f = fixture(t)
  for (let i = 0; i < 12; i++) {
    f.write(i)
    for (const mode of [undefined, '', 'off', 'shadow', 'future']) assert.equal(D.selectInstallProfile(f.root, info, mode), null)
    const want = legacy.key(f.root, info, f.facts, f.env)
    assert.equal(D.key(f.root, info, f.facts, f.env), want)
    assert.equal(f.key('unknown-profile'), want)
    assert.deepEqual(D.npmPaths(f.root, f.root), legacy.npmPaths(f.root, f.root))
  }
})

test('unreviewed bytes, pairings, manifest inventory and implicit install inputs decline to the old key', t => {
  const f = fixture(t)
  const attempts = [
    () => fs.appendFileSync(path.join(f.root, 'package.json'), '\n'),
    () => fs.appendFileSync(path.join(f.root, 'package-lock.json'), '\n'),
    () => fs.writeFileSync(path.join(f.root, 'package-lock.json'), window.blobs[window.commits[11].files['package-lock.json']]),
    () => fs.rmSync(path.join(f.root, 'packages/convex-helpers/package.json')),
    () => fs.appendFileSync(path.join(f.root, 'packages/convex-helpers/package.json'), '\n'),
    () => { fs.mkdirSync(path.join(f.root, 'unknown')); fs.writeFileSync(path.join(f.root, 'unknown/package.json'), '{}') },
    () => fs.writeFileSync(path.join(f.root, 'binding.gyp'), '{}'),
    () => fs.symlinkSync('absent-target', path.join(f.root, 'binding.gyp')),
    () => fs.writeFileSync(path.join(f.root, 'npm-shrinkwrap.json'), '{}'),
    () => { const p = path.join(f.root, 'package.json'); fs.renameSync(p, p + '.original'); fs.symlinkSync(p + '.original', p) },
    () => { const p = path.join(f.root, 'package-lock.json'); fs.renameSync(p, p + '.original'); fs.symlinkSync(p + '.original', p) },
    () => { const p = path.join(f.root, 'packages/convex-helpers/package.json'); fs.renameSync(p, p + '.original'); fs.symlinkSync(p + '.original', p) },
  ]
  for (const [i, update] of attempts.entries()) {
    f.write(0); update()
    assert.equal(f.profile(), null, `decline case ${i}`)
    assert.equal(f.key(P.ID), legacy.key(f.root, info, f.facts, f.env), `legacy key case ${i}`)
    assert.deepEqual(D.npmPaths(f.root, f.root, P.ID), legacy.npmPaths(f.root, f.root), `legacy paths case ${i}`)
  }
})

test('lifecycle, workspace, local, link and new dependency changes cannot enter the finite profile', t => {
  const f = fixture(t)
  const updates = [
    ...['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'].map(name => pkg => { pkg.scripts[name] = 'node observe-project.mjs' }),
    pkg => { pkg.workspaces = ['packages/*'] },
    ...['file:./local', 'link:./local', 'workspace:*', './local', '../local', '/tmp/local'].map(value => pkg => { pkg.dependencies = {local: value} }),
    pkg => { pkg.devDependencies.chalk = '100.0.0' },
    pkg => { pkg.exports['./new'] = './unreviewed.js' },
  ]
  for (const [i, update] of updates.entries()) {
    f.write(0); changePackage(f.root, update)
    assert.equal(f.profile(), null, `unsafe or unreviewed root case ${i}`)
    assert.equal(f.key(P.ID), legacy.key(f.root, info, f.facts, f.env))
  }
  for (const update of [lock => { lock.packages['local'] = {} },
    lock => { lock.packages['node_modules/local'] = {link: true, resolved: '../local'} },
    lock => { lock.packages[''].workspaces = ['packages/*'] }]) {
    f.write(0)
    const file = path.join(f.root, info.lock), lock = JSON.parse(fs.readFileSync(file))
    update(lock); fs.writeFileSync(file, JSON.stringify(lock))
    assert.equal(f.profile(), null)
    assert.equal(f.key(P.ID), legacy.key(f.root, info, f.facts, f.env))
  }
})

test('npmrc, npm environment, Node/npm versions and platform-image scope remain keyed', t => {
  const f = fixture(t); f.write(0)
  const baseline = f.key()
  for (const [label, env, facts] of [
    ['node', f.env, {...f.facts, node: 'different-node'}],
    ['npm', f.env, {...f.facts, npm: 'different-npm'}],
    ['image OS', {...f.env, ImageOS: 'different-image'}, f.facts],
    ['NODE_ENV', {...f.env, NODE_ENV: 'production'}, f.facts],
    ['npm omit', {...f.env, npm_config_omit: 'dev'}, f.facts],
    ['npm peer policy', {...f.env, NPM_CONFIG_LEGACY_PEER_DEPS: 'true'}, f.facts],
  ]) assert.notEqual(f.key(P.ID, env, facts), baseline, label)
  for (const file of [path.join(f.root, '.npmrc'), f.env.NPM_CONFIG_USERCONFIG, f.env.NPM_CONFIG_GLOBALCONFIG]) {
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null
    fs.writeFileSync(file, 'ignore-scripts=true\n')
    assert.notEqual(f.key(), baseline, file)
    if (before) fs.writeFileSync(file, before)
    else fs.rmSync(file)
  }
  assert.equal(f.key(), baseline)
  fs.writeFileSync(path.join(f.root, 'unrelated-source.ts'), 'export const changed = true\n')
  assert.equal(f.key(), baseline, 'source bytes have separate build/test authority')
})

test('main selects the profile only for the explicit supported managed modes', async t => {
  const f = fixture(t)
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const source = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
  const selected = []
  for (const [managed, mode, platform, arch, admitted] of [
    ['v0', 'check', 'linux', 'x64', true], ['control', 'check', 'linux', 'x64', true],
    ['matrix-research', 'check', 'linux', 'x64', true], ['matrix-control', 'check', 'linux', 'x64', true],
    ['off', 'check', 'linux', 'x64', false], ['future', 'check', 'linux', 'x64', false],
    ['v0', 'shadow', 'linux', 'x64', false], ['v0', 'check', 'darwin', 'arm64', false],
    ['control', 'check', 'linux', 'arm64', false], ['matrix-research', 'shadow', 'linux', 'x64', false],
    ['matrix-control', 'check', 'darwin', 'x64', false],
  ]) {
    f.write(0)
    const restores = [], states = new Map(), inputs = {'managed-vitest': managed, mode}
    const result = await vm.runInNewContext(source + '; dependencies(' + JSON.stringify(f.facts) + ')', {
      D, fs, path, crypto, Date,
      process: {platform, arch, env: {...f.env, GITHUB_WORKSPACE: f.root}, cwd: () => f.root},
      core: {getInput: name => inputs[name] ?? '', info() {}, saveState: (name, value) => states.set(name, value)},
      cache: {restoreCache: async (...args) => { restores.push(args); return undefined }},
      cacheNamespace: () => 'fixture-', maySave: () => true, home: () => f.base,
    })
    assert.equal(result.installProfile ?? null, admitted ? P.ID : null, `${managed}/${mode}/${platform}/${arch}`)
    assert.equal(result.hit, '', 'a profile never supplies an absent dependency tree')
    assert.equal(restores.length, 2, 'node_modules and download-cache materialization still run')
    assert.equal(JSON.parse(states.get('deps')).installProfile ?? null, admitted ? P.ID : null)
    const want = admitted ? f.key(P.ID) : legacy.key(f.root, info, f.facts, {...f.env, GITHUB_WORKSPACE: f.root})
    assert.equal(result.key, want)
    if (admitted) selected.push(result.key)
  }
  assert.equal(selected[0], selected[1], 'replay and control have the same install policy')
})

test('managed binding.gyp and competing shrinkwrap decline all dependency-tree authority while off stays legacy', async t => {
  const f = fixture(t)
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const source = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
  const variants = [
    () => fs.writeFileSync(path.join(f.root, 'binding.gyp'), '{}'),
    () => fs.symlinkSync('missing-gyp', path.join(f.root, 'binding.gyp')),
    () => fs.writeFileSync(path.join(f.root, 'npm-shrinkwrap.json'), '{}'),
    () => fs.symlinkSync('missing-shrinkwrap', path.join(f.root, 'npm-shrinkwrap.json')),
  ]
  for (const update of variants) for (const mode of ['v0', 'control', 'matrix-research', 'matrix-control', 'off']) {
    f.write(0); update()
    const restores = [], states = [], messages = []
    const result = await vm.runInNewContext(source + '; dependencies(' + JSON.stringify(f.facts) + ')', {
      D: mode === 'off' ? D : {...D, key: () => { throw new Error('a declined managed install must not compute a cache key') }},
      fs, path, crypto, Date, process: {platform: 'linux', arch: 'x64', env: {...f.env, GITHUB_WORKSPACE: f.root}, cwd: () => f.root},
      core: {getInput: name => name === 'managed-vitest' ? mode : '', info: value => messages.push(value), saveState: (...args) => states.push(args)},
      cache: {restoreCache: async (...args) => { restores.push(args); return undefined }},
      cacheNamespace: () => 'fixture-', maySave: () => true, home: () => f.base,
    })
    if (mode === 'off') {
      assert.equal(result.key, legacy.key(f.root, info, f.facts, f.env))
      assert.equal(restores.length, 2); assert.equal(states.length, 1)
      assert.equal(result.installProfile, undefined)
    } else {
      assert.equal(result, null)
      assert.deepEqual(restores, []); assert.deepEqual(states, [])
      assert.match(messages.join('\n'), /no dependency tree is restored or saved, and native npm ci runs/)
    }
  }
})

function invokeHook(f, {tree = true, marker = true, mutate, args = ['ci']} = {}) {
  f.write(0)
  const base = path.join(f.base, 'hook'), npm = path.join(base, 'npm'), bin = path.join(npm, 'bin/npm-cli.js')
  fs.mkdirSync(path.dirname(bin), {recursive: true}); fs.writeFileSync(bin, '')
  fs.writeFileSync(path.join(npm, 'package.json'), JSON.stringify({version: f.facts.npm}))
  const key = f.key(), nm = path.join(f.root, 'node_modules')
  if (tree) {
    fs.mkdirSync(nm)
    fs.writeFileSync(path.join(nm, '.package-lock.json'), '{"version":"0.1.129","packages":{}}')
    if (marker) fs.writeFileSync(path.join(nm, '.quod-deps.json'), JSON.stringify({key, args: [], npm: f.facts.npm}))
  }
  const st = {root: f.root, ws: f.root, pm: 'npm', info, key, installProfile: P.ID,
    facts: f.facts, paths: D.npmPaths(f.root, f.root, P.ID), hit: 'exact', print: D.treePrint(f.root)}
  fs.writeFileSync(path.join(base, 'deps.json'), JSON.stringify(st))
  if (mutate) mutate({nm, npm, st})
  const stopped = {}, messages = [], listeners = [], exits = []
  try {
    vm.runInNewContext(npmCi + '; npmCi(' + JSON.stringify(bin) + ', ' + JSON.stringify(args) + ')', {
      __dirname: base, require: name => name.endsWith('deps.cjs') ? D : require(name), console: {log: value => messages.push(value)},
      process: {version: f.facts.node, execPath: process.execPath, env: f.env, cwd: () => f.root,
        on: (name, callback) => listeners.push([name, callback]), exit: code => { exits.push(code); throw stopped }},
    })
  } catch (error) { if (error !== stopped) throw error }
  return {messages, listeners, exits, base}
}

test('the npm hook requires an actual restored tree, marker, arguments and unchanged current inputs', t => {
  const f = fixture(t)
  const valid = invokeHook(f)
  assert.deepEqual(valid.exits, [0]); assert.equal(valid.listeners.length, 0)
  assert.match(valid.messages.join('\n'), /npm ci skipped/)
  const equivalent = invokeHook(f, {mutate: () => {
    fs.writeFileSync(path.join(f.root, 'package.json'), window.blobs[window.commits[4].files['package.json']])
    fs.rmSync(path.join(f.root, 'packages/convex-helpers/package.json'))
  }})
  assert.deepEqual(equivalent.exits, [0], 'the reviewed c0 to c5 install projection can use the materialized tree')
  for (const options of [{tree: false}, {marker: false}, {args: ['ci', '--ignore-scripts']},
    {mutate: ({nm}) => fs.mkdirSync(path.join(nm, 'changed-after-restore'))},
    {mutate: () => changePackage(f.root, pkg => { pkg.scripts.prepare = 'node observe.mjs' })},
    {mutate: () => fs.writeFileSync(path.join(f.root, 'package-lock.json'), window.blobs[window.commits[11].files['package-lock.json']])},
    {mutate: ({npm}) => fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"changed-npm"}')},
  ]) {
    const result = invokeHook(f, options)
    assert.deepEqual(result.exits, [], 'native npm must run')
    assert.equal(result.listeners.length, 1)
    result.listeners[0][1](1)
    assert.equal(fs.existsSync(path.join(result.base, 'deps-installed.json')), false, 'a failed native install cannot mint authority')
  }
})
