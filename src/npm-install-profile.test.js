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
  const node = path.join(base, 'toolchain/bin/node'), npm = path.join(base, 'toolchain/lib/node_modules/npm')
  fs.mkdirSync(path.dirname(node), {recursive: true}); fs.writeFileSync(node, '')
  fs.mkdirSync(path.join(npm, 'bin'), {recursive: true}); fs.writeFileSync(path.join(npm, 'bin/npm-cli.js'), '')
  fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"fixture-npm-version"}')
  const env = {HOME: base, ImageOS: 'ubuntu24', ImageVersion: 'fixture-image',
    NPM_CONFIG_USERCONFIG: path.join(base, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(base, 'global.npmrc')}
  const facts = {node: process.version, npm: 'fixture-npm-version', bin: node}
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
  function syntheticBlankConfigVariant(i) {
    write(i)
    // This synthetic admission control changes ONLY .npmrc. The actual twelve
    // inputs contain min-release-age=7 and now require native installation.
    fs.writeFileSync(path.join(root, '.npmrc'), '# Synthetic blank-config admission control.\n')
  }
  const profile = (mode = 'v0') => D.selectInstallProfile(root, info, mode)
  const key = (requested = profile(), e = env, f = facts) => D.key(root, info, f, e, requested)
  return {base, root, env, facts, npm, write, syntheticBlankConfigVariant, profile, key}
}
function changePackage(root, update) {
  const file = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(file))
  update(pkg)
  fs.writeFileSync(file, JSON.stringify(pkg))
}

test('the twelve original manifest projections retain ten equivalent keys only in synthetic blank-config variants', t => {
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
    assert.equal(f.profile('matrix-property47'), P.ID, `property47 research c${i}`)
    assert.equal(f.profile('matrix-property47-control'), P.ID, `property47 control c${i}`)
    assert.equal(P.select(f.root, info, 'v0', D.manifests(f.root)), P.ID, 'pure finite manifest/lock selection remains independent of npm config admission')
    assert.throws(() => f.key(), /\.npmrc contains npm configuration that requires native installation/, `original c${i} requires native npm`)
    old.push(legacy.key(f.root, info, f.facts, f.env))
    paths.push(D.npmPaths(f.root, f.root, f.profile()))
    raw.push(hash(before))
    const projection = P.project(f.root, info, P.ID, D.manifests(f.root))
    f.syntheticBlankConfigVariant(i)
    assert.deepEqual(P.project(f.root, info, P.ID, D.manifests(f.root)), projection, 'only synthetic npm config admission changed')
    keys.push(f.key())
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

test('safe default-off keys rotate old npm entries while preserving cache paths and profile selection', t => {
  const f = fixture(t)
  for (let i = 0; i < 12; i++) {
    f.syntheticBlankConfigVariant(i)
    for (const mode of [undefined, '', 'off', 'shadow', 'future']) assert.equal(D.selectInstallProfile(f.root, info, mode), null)
    const want = D.key(f.root, info, f.facts, f.env)
    assert.notEqual(want, legacy.key(f.root, info, f.facts, f.env), 'old npm trees lack the new install safety policy')
    assert.equal(f.key('unknown-profile'), want)
    assert.deepEqual(D.npmPaths(f.root, f.root), legacy.npmPaths(f.root, f.root))
  }
})

test('unreviewed inputs leave the finite profile and unsafe install inputs cannot mint a key', t => {
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
    f.syntheticBlankConfigVariant(0); update()
    assert.equal(f.profile(), null, `decline case ${i}`)
    if ([6, 7, 8, 9, 10].includes(i)) assert.throws(() => f.key(P.ID), /npm dependency reuse declined/, `unsafe key case ${i}`)
    else assert.equal(f.key(P.ID), D.key(f.root, info, f.facts, f.env), `unprofiled key case ${i}`)
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
    f.syntheticBlankConfigVariant(0); changePackage(f.root, update)
    assert.equal(f.profile(), null, `unsafe or unreviewed root case ${i}`)
    if (i >= 8 && i <= 14) assert.throws(() => f.key(P.ID), /npm dependency reuse declined/)
    else assert.equal(f.key(P.ID), D.key(f.root, info, f.facts, f.env))
  }
  for (const update of [lock => { lock.packages['local'] = {} },
    lock => { lock.packages['node_modules/local'] = {link: true, resolved: '../local'} },
    lock => { lock.packages[''].workspaces = ['packages/*'] }]) {
    f.syntheticBlankConfigVariant(0)
    const file = path.join(f.root, info.lock), lock = JSON.parse(fs.readFileSync(file))
    update(lock); fs.writeFileSync(file, JSON.stringify(lock))
    assert.equal(f.profile(), null)
    assert.throws(() => f.key(P.ID), /npm dependency reuse declined/)
  }
})

test('synthetic blank-config admission retains environment, Node/npm and platform-image scope and refuses significant npmrc', t => {
  const f = fixture(t); f.syntheticBlankConfigVariant(0)
  const baseline = f.key()
  for (const [label, env, facts] of [
    ['node', f.env, {...f.facts, node: 'different-node'}],
    ['npm', f.env, {...f.facts, npm: 'different-npm'}],
    ['image OS', {...f.env, ImageOS: 'different-image'}, f.facts],
    ['NODE_ENV', {...f.env, NODE_ENV: 'production'}, f.facts],
    ['npm omit', {...f.env, npm_config_omit: 'dev'}, f.facts],
    ['npm peer policy', {...f.env, NPM_CONFIG_LEGACY_PEER_DEPS: 'true'}, f.facts],
  ]) {
    if (label.startsWith('npm ')) assert.throws(() => f.key(P.ID, env, facts), /requires native installation/, label)
    else assert.notEqual(f.key(P.ID, env, facts), baseline, label)
  }
  for (const file of [path.join(f.root, '.npmrc'), f.env.NPM_CONFIG_USERCONFIG, f.env.NPM_CONFIG_GLOBALCONFIG]) {
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null
    fs.writeFileSync(file, 'ignore-scripts=true\n')
    assert.throws(() => f.key(), /requires native installation/, file)
    if (before) fs.writeFileSync(file, before)
    else fs.rmSync(file)
  }
  assert.equal(f.key(), baseline)
  fs.writeFileSync(path.join(f.root, 'unrelated-source.ts'), 'export const changed = true\n')
  assert.equal(f.key(), baseline, 'source bytes have separate build/test authority')
})

test('main selects the synthetic blank-config profile only for the explicit supported managed modes', async t => {
  const f = fixture(t)
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const source = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
  const selected = []
  for (const [managed, mode, platform, arch, admitted] of [
    ['v0', 'check', 'linux', 'x64', true], ['control', 'check', 'linux', 'x64', true],
    ['matrix-research', 'check', 'linux', 'x64', true], ['matrix-control', 'check', 'linux', 'x64', true],
    ['matrix-property47', 'check', 'linux', 'x64', true], ['matrix-property47-control', 'check', 'linux', 'x64', true],
    ['off', 'check', 'linux', 'x64', false], ['future', 'check', 'linux', 'x64', false],
    ['v0', 'shadow', 'linux', 'x64', false], ['v0', 'check', 'darwin', 'arm64', false],
    ['control', 'check', 'linux', 'arm64', false], ['matrix-research', 'shadow', 'linux', 'x64', false],
    ['matrix-control', 'check', 'darwin', 'x64', false],
    ['matrix-property47', 'shadow', 'linux', 'x64', false], ['matrix-property47-control', 'check', 'linux', 'arm64', false],
  ]) {
    f.syntheticBlankConfigVariant(0)
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
    const want = admitted ? f.key(P.ID) : D.key(f.root, info, f.facts, {...f.env, GITHUB_WORKSPACE: f.root})
    assert.equal(result.key, want)
    if (admitted) selected.push(result.key)
  }
  assert.equal(selected[0], selected[1], 'replay and control have the same install policy')
})

test('all twelve actual npmrc inputs decline setup before any cache restore or saved state', async t => {
  const f = fixture(t)
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const source = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
  for (let i = 0; i < 12; i++) {
    f.write(i)
    const before = fs.readFileSync(path.join(f.root, '.npmrc'))
    assert.equal(hash(before), window.commits[i].files['.npmrc'], `original c${i} npm config bytes`)
    for (const mode of ['off', 'matrix-research']) {
      const restores = [], states = [], messages = []
      assert.throws(() => f.key(mode === 'off' ? null : P.ID), /\.npmrc contains npm configuration that requires native installation/)
      const result = await vm.runInNewContext(source + '; dependencies(' + JSON.stringify(f.facts) + ')', {
        D: {...D, key: () => { throw new Error('original configured inputs must not compute a cache key') }},
        fs, path, crypto, Date, process: {platform: 'linux', arch: 'x64', env: {...f.env, GITHUB_WORKSPACE: f.root}, cwd: () => f.root},
        core: {getInput: name => name === 'managed-vitest' ? mode : '', info: value => messages.push(value), saveState: (...args) => states.push(args)},
        cache: {restoreCache: async (...args) => { restores.push(args); return undefined }},
        cacheNamespace: () => 'fixture-', maySave: () => true, home: () => f.base,
      })
      assert.equal(result, null)
      assert.deepEqual(restores, []); assert.deepEqual(states, [])
      assert.match(messages.join('\n'), /\.npmrc contains npm configuration that requires native installation; no dependency tree is restored or saved, and native npm ci runs/)
    }
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.npmrc')), before, 'original fixture remains unchanged')
  }
})

test('binding.gyp and competing shrinkwrap decline dependency-tree authority in every mode', async t => {
  const f = fixture(t)
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const source = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
  const variants = [
    () => fs.writeFileSync(path.join(f.root, 'binding.gyp'), '{}'),
    () => fs.symlinkSync('missing-gyp', path.join(f.root, 'binding.gyp')),
    () => fs.writeFileSync(path.join(f.root, 'npm-shrinkwrap.json'), '{}'),
    () => fs.symlinkSync('missing-shrinkwrap', path.join(f.root, 'npm-shrinkwrap.json')),
  ]
  for (const update of variants) for (const mode of ['v0', 'control', 'matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control', 'off']) {
    f.write(0); update()
    const restores = [], states = [], messages = []
    const result = await vm.runInNewContext(source + '; dependencies(' + JSON.stringify(f.facts) + ')', {
      D: {...D, key: () => { throw new Error('a declined install must not compute a cache key') }},
      fs, path, crypto, Date, process: {platform: 'linux', arch: 'x64', env: {...f.env, GITHUB_WORKSPACE: f.root}, cwd: () => f.root},
      core: {getInput: name => name === 'managed-vitest' ? mode : '', info: value => messages.push(value), saveState: (...args) => states.push(args)},
      cache: {restoreCache: async (...args) => { restores.push(args); return undefined }},
      cacheNamespace: () => 'fixture-', maySave: () => true, home: () => f.base,
    })
    assert.equal(result, null)
    assert.deepEqual(restores, []); assert.deepEqual(states, [])
    assert.match(messages.join('\n'), /no dependency tree is restored or saved, and native npm ci runs/)
  }
})

function invokeHook(f, {tree = true, marker = true, mutate, args = ['ci']} = {}) {
  f.syntheticBlankConfigVariant(0)
  const base = path.join(f.base, 'hook'), npm = f.npm, bin = path.join(npm, 'bin/npm-cli.js')
  fs.mkdirSync(base, {recursive: true})
  fs.writeFileSync(path.join(npm, 'package.json'), JSON.stringify({version: f.facts.npm}))
  const key = f.key(), nm = path.join(f.root, 'node_modules')
  if (tree) {
    fs.mkdirSync(nm)
    fs.writeFileSync(path.join(nm, '.package-lock.json'), '{"version":"0.1.129","packages":{}}')
    if (marker) fs.writeFileSync(path.join(nm, '.quod-deps.json'), JSON.stringify({key, args: [], npm: f.facts.npm}))
  }
  const st = {root: f.root, ws: f.root, pm: 'npm', info, key, installProfile: P.ID,
    facts: f.facts, paths: D.npmPaths(f.root, f.root, P.ID), hit: 'exact', print: D.fullPrint(f.root, D.npmPaths(f.root, f.root, P.ID))}
  fs.writeFileSync(path.join(base, 'deps.json'), JSON.stringify(st))
  if (mutate) mutate({nm, npm, st})
  const stopped = {}, messages = [], listeners = [], exits = []
  try {
    vm.runInNewContext(npmCi + '; npmCi(' + JSON.stringify(bin) + ', ' + JSON.stringify(args) + ')', {
      __dirname: base, require: name => name.endsWith('deps.cjs') ? D : require(name), console: {log: value => messages.push(value)},
      process: {version: f.facts.node, execPath: f.facts.bin, env: f.env, cwd: () => f.root,
        on: (name, callback) => listeners.push([name, callback]), exit: code => { exits.push(code); throw stopped }},
    })
  } catch (error) { if (error !== stopped) throw error }
  return {messages, listeners, exits, base}
}

test('the synthetic blank-config npm hook requires an actual restored tree, marker, arguments and unchanged current inputs', t => {
  const f = fixture(t)
  const valid = invokeHook(f)
  assert.deepEqual(valid.exits, [0]); assert.equal(valid.listeners.length, 0)
  assert.match(valid.messages.join('\n'), /npm ci skipped/)
  const equivalent = invokeHook(f, {mutate: () => {
    fs.writeFileSync(path.join(f.root, 'package.json'), window.blobs[window.commits[4].files['package.json']])
    fs.rmSync(path.join(f.root, 'packages/convex-helpers/package.json'))
  }})
  assert.deepEqual(equivalent.exits, [0], 'the synthetic blank-config c0 to c5 projection can use the materialized tree')
  for (const options of [{tree: false}, {marker: false},
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
  const unsupported = invokeHook(f, {args: ['ci', '--ignore-scripts']})
  assert.deepEqual(unsupported.exits, [])
  assert.equal(unsupported.listeners.length, 0, 'unsupported install arguments grant no tree authority')
})
