'use strict'
// These source integration fixtures run on GitHub. They use the real deps,
// setup, hook and post functions, with synthetic cache materialization only;
// they do not claim an actual npm install or SDK authentication.
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const D = require('../deps.cjs')
const legacy = require('../test/fixtures/deps-v4.cjs')
const {saveTogether} = require('./saves')
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const setup = main.slice(main.indexOf('async function dependencies('), main.indexOf('\n// The task cache:'))
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')
const install = hook.slice(hook.indexOf('function npmCi('), hook.indexOf('\n// `npm run <script>`'))
const post = fs.readFileSync(path.join(__dirname, 'post.js'), 'utf8')
const publish = post.slice(post.indexOf('async function dependencies('), post.indexOf('\nasync function run()'))

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-npm-safety-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project'), job = path.join(base, 'job')
  const node = path.join(base, 'toolchain/bin/node'), npm = path.join(base, 'toolchain/lib/node_modules/npm')
  fs.mkdirSync(root); fs.mkdirSync(job); fs.mkdirSync(path.join(npm, 'bin'), {recursive: true})
  fs.mkdirSync(path.dirname(node), {recursive: true}); fs.writeFileSync(node, '')
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"install-safety","version":"1.0.0"}')
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"install-safety","lockfileVersion":3,"packages":{"":{"name":"install-safety","version":"1.0.0"}}}')
  fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"11.0.0"}')
  const bin = path.join(npm, 'bin/npm-cli.js'); fs.writeFileSync(bin, '')
  const env = {HOME: base, GITHUB_WORKSPACE: root, ImageOS: 'fixture',
    NPM_CONFIG_USERCONFIG: path.join(base, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(base, 'global.npmrc')}
  const facts = {node: process.version, npm: '11.0.0', bin: node}
  const info = {pm: 'npm', lock: 'package-lock.json'}
  const key = D.key(root, info, facts, env)
  const st = {root, ws: root, pm: 'npm', info, key, facts, paths: D.npmPaths(root, root), hit: 'exact', save: true}
  return {base, root, job, bin, npm, env, facts, info, key, st}
}
function manifest(f, update) {
  const file = path.join(f.root, 'package.json'), value = JSON.parse(fs.readFileSync(file))
  update(value); fs.writeFileSync(file, JSON.stringify(value))
}
const uncertain = [
  ['root binding.gyp', f => fs.writeFileSync(path.join(f.root, 'binding.gyp'), '{'), /binding\.gyp/],
  ['dangling binding.gyp', f => fs.symlinkSync('absent', path.join(f.root, 'binding.gyp')), /binding\.gyp/],
  ['competing shrinkwrap', f => fs.writeFileSync(path.join(f.root, 'npm-shrinkwrap.json'), '{'), /overrides/],
  ['dangling shrinkwrap', f => fs.symlinkSync('absent', path.join(f.root, 'npm-shrinkwrap.json')), /overrides/],
  ['workspace implicit install', f => {
    manifest(f, p => {p.workspaces = ['packages/*']})
    const dir = path.join(f.root, 'packages/child'); fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"workspace-child","version":"1.0.0"}')
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{')
  }, /workspaces/],
  ['hidden workspace', f => manifest(f, p => {p.workspaces = ['.packages/*']}), /workspaces/],
  ['symlinked workspace', f => {
    manifest(f, p => {p.workspaces = ['packages/*']})
    fs.mkdirSync(path.join(f.root, 'packages')); fs.symlinkSync(f.base, path.join(f.root, 'packages/linked'))
  }, /workspaces/],
  ['local source dependency', f => manifest(f, p => {p.dependencies = {local: 'file:../external'}}), /local or linked/],
  ['lockfile-only local link', f => {
    const file = path.join(f.root, 'package-lock.json'), value = JSON.parse(fs.readFileSync(file))
    value.packages['node_modules/local'] = {link: true, resolved: '../external'}
    fs.writeFileSync(file, JSON.stringify(value))
  }, /workspace or local/],
  ...['git+file:../external', 'local-package.tgz', 'local-package.tar', 'vendor/local/package'].map(spec =>
    [spec, f => manifest(f, p => {p.dependencies = {local: spec}}), /local or linked/]),
  ['local archive with missing resolved metadata', f => {
    manifest(f, p => {p.dependencies = {local: 'local-package.tar.gz'}})
    const file = path.join(f.root, 'package-lock.json'), value = JSON.parse(fs.readFileSync(file))
    value.packages['node_modules/local'] = {version: '1.0.0'}
    fs.writeFileSync(file, JSON.stringify(value))
  }, /local or linked/],
  ['HTTP archive after another dependency', f => manifest(f, p => {
    p.dependencies = {first: '1.0.0', archive: 'https://example.invalid/local-package.tgz'}
  }), /local or linked/],
  ['project npmrc interpolation', f => fs.writeFileSync(path.join(f.root, '.npmrc'), 'omit=${INSTALL_OMIT}\n'), /environment interpolation/],
  ['user npmrc interpolation', f => fs.writeFileSync(f.env.NPM_CONFIG_USERCONFIG, 'omit=${INSTALL_OMIT?}\n'), /environment interpolation/],
  ['global npmrc interpolation', f => fs.writeFileSync(f.env.NPM_CONFIG_GLOBALCONFIG, 'omit=\\${INSTALL_OMIT}\n'), /environment interpolation/],
  ['builtin npmrc interpolation', f => fs.writeFileSync(path.join(f.npm, 'npmrc'), 'omit=${INSTALL_OMIT}\n'), /environment interpolation/],
  ['npmrc configuration redirect', f => fs.writeFileSync(path.join(f.root, '.npmrc'), 'globalconfig=./extra.npmrc\n'), /configuration that requires/],
  ['default user npmrc', f => {
    delete f.env.NPM_CONFIG_USERCONFIG; fs.writeFileSync(path.join(f.base, '.npmrc'), 'omit=dev\n')
  }, /userconfig contains/],
  ['default global npmrc from the saved Node path', f => {
    delete f.env.NPM_CONFIG_GLOBALCONFIG
    const file = path.join(f.base, 'toolchain/etc/npmrc'); fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, 'omit=dev\n')
  }, /globalconfig contains/],
  ['mixed-case user config environment', f => {
    delete f.env.NPM_CONFIG_USERCONFIG
    f.env.Npm_Config_Userconfig = path.join(f.base, 'mixed-user.npmrc')
    fs.writeFileSync(f.env.Npm_Config_Userconfig, 'omit=dev\n')
  }, /userconfig contains/],
  ['mixed-case global config environment', f => {
    delete f.env.NPM_CONFIG_GLOBALCONFIG
    f.env.Npm_Config_Globalconfig = path.join(f.base, 'mixed-global.npmrc')
    fs.writeFileSync(f.env.Npm_Config_Globalconfig, 'omit=dev\n')
  }, /globalconfig contains/],
  ['semantic npm environment', f => {f.env.NPM_CONFIG_OMIT = 'dev'}, /environment configuration/],
  ['interpolated npm environment', f => {f.env.NPM_CONFIG_LOGLEVEL = '${CUSTOM}'}, /environment interpolation/],
  ['duplicate case npm environment', f => {f.env.npm_config_userconfig = f.env.NPM_CONFIG_USERCONFIG}, /duplicate npm environment/],
  ['relative npm config environment', f => {f.env.NPM_CONFIG_USERCONFIG = './extra.npmrc'}, /relative npm configuration/],
  ['PREFIX environment', f => {f.env.PREFIX = f.base}, /prefix or global/],
  ['DESTDIR environment', f => {f.env.DESTDIR = f.base}, /prefix or global/],
  ['esbuild binary override', f => {f.env.ESBUILD_BINARY_PATH = path.join(f.base, 'custom-esbuild')}, /ESBUILD_BINARY_PATH/],
]
async function runSetup(f) {
  const restored = [], states = [], messages = []
  const result = await vm.runInNewContext(setup + '; dependencies(' + JSON.stringify(f.facts) + ')', {
    D, fs, path, crypto, Date,
    process: {platform: 'linux', arch: 'x64', env: f.env, cwd: () => f.root},
    core: {getInput: () => '', info: value => messages.push(value), saveState: (...args) => states.push(args)},
    cache: {restoreCache: async (...args) => {restored.push(args); return undefined}},
    cacheNamespace: () => '', maySave: () => true, home: () => f.base,
  })
  return {result, restored, states, messages}
}
function restoredTree(f) {
  const nm = path.join(f.root, 'node_modules'); fs.mkdirSync(nm)
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}')
  fs.writeFileSync(path.join(nm, '.quod-deps.json'), JSON.stringify({key: f.key, args: [], npm: f.facts.npm}))
  f.st.print = D.fullPrint(f.root, f.st.paths)
  fs.writeFileSync(path.join(f.job, 'deps.json'), JSON.stringify(f.st))
  fs.writeFileSync(path.join(f.job, 'deps-installed.json'), 'stale previous install note')
}
function runHook(f) {
  const exits = [], listeners = [], messages = [], stopped = {}
  try {
    vm.runInNewContext(install + '; npmCi(' + JSON.stringify(f.bin) + ', ["ci"])', {
      __dirname: f.job, require: name => name.endsWith('deps.cjs') ? D : require(name),
      console: {log: value => messages.push(value)},
      process: {version: process.version, execPath: f.facts.bin, env: f.env, cwd: () => f.root,
        on: (...args) => listeners.push(args), exit: code => {exits.push(code); throw stopped}},
    })
  } catch (error) {if (error !== stopped) throw error}
  return {exits, listeners, messages}
}
async function runPost(f) {
  const saved = [], messages = []
  const st = {...f.st, hit: ''}
  fs.writeFileSync(path.join(f.job, 'deps-installed.json'), JSON.stringify({key: f.key, args: [], print: D.fullPrint(f.root, st.paths)}))
  await vm.runInNewContext(publish + '; dependencies()', {
    fs, path, D, Date, saveTogether, paths: {base: f.job}, process: {env: {...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch'}},
    core: {getState: () => JSON.stringify(st), info: value => messages.push(value)},
    cache: {saveCache: async (...args) => {saved.push(args); return 1}},
  })
  return {saved, messages}
}

test('ordinary setup declines uncertain install inputs before any cache restore or saved state', async t => {
  for (const [name, mutate, reason] of uncertain) {
    const f = fixture(t); mutate(f)
    const value = await runSetup(f)
    assert.equal(value.result, null, name)
    assert.deepEqual(value.restored, [], name); assert.deepEqual(value.states, [], name)
    assert.match(value.messages.join('\n'), reason)
    assert.match(value.messages.join('\n'), /native npm ci runs/)
  }
})
test('a restored exact-key tree cannot skip npm after an implicit install input appears', t => {
  for (const [name, mutate] of uncertain) {
    const f = fixture(t); restoredTree(f); mutate(f)
    const value = runHook(f)
    assert.deepEqual(value.exits, [], name)
    assert.deepEqual(value.listeners, [], name + ': no successful-install authority is registered')
    assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false, name + ': prior note is cleared')
    assert.doesNotMatch(value.messages.join('\n'), /npm ci skipped/, name)
  }
})
test('post does not save a tree after implicit or workspace install uncertainty appears', async t => {
  for (const [name, mutate, reason] of uncertain) {
    const f = fixture(t); restoredTree(f); mutate(f)
    const value = await runPost(f)
    assert.deepEqual(value.saved, [], name)
    assert.match(value.messages.join('\n'), reason)
  }
})
test('ordinary safe npm installs rotate legacy authority and retain setup, skip and save controls', async t => {
  const f = fixture(t)
  assert.notEqual(f.key, legacy.key(f.root, f.info, f.facts, f.env))
  assert.equal(D.key(f.root, f.info, f.facts, f.env), f.key, 'unchanged safe inputs repeat the same new key')
  const setup = await runSetup(f)
  assert.equal(setup.result.key, f.key); assert.equal(setup.restored.length, 2); assert.equal(setup.states.length, 1)
  restoredTree(f)
  assert.deepEqual(runHook(f).exits, [0], 'an unchanged exact restored tree may still skip npm')
  const result = await runPost(f)
  assert.equal(result.saved.length, 1)
  assert.match(result.messages.join('\n'), /node_modules saved/)
})
test('an old npm cache key and marker cannot answer for npm under the new safety domain', t => {
  const f = fixture(t); restoredTree(f)
  const oldKey = legacy.key(f.root, f.info, f.facts, f.env)
  const st = {...f.st, key: oldKey}
  fs.writeFileSync(path.join(f.job, 'deps.json'), JSON.stringify(st))
  fs.writeFileSync(path.join(f.root, 'node_modules/.quod-deps.json'), JSON.stringify({key: oldKey, args: [], npm: f.facts.npm}))
  const value = runHook(f)
  assert.deepEqual(value.exits, [], 'the stale tree cannot skip npm even when its old key and marker agree')
  assert.equal(value.listeners.length, 1, 'native installation may produce a fresh new-key record')
  assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false)
  value.listeners[0][1](1)
  assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false, 'a failed native install grants no new authority')
})
test('the npm safety-domain rotation leaves other package-manager store keys unchanged', t => {
  const f = fixture(t)
  for (const pm of ['pnpm', 'yarn', 'yarn-berry', 'bun']) {
    const info = {...f.info, pm}
    assert.equal(D.key(f.root, info, f.facts, f.env), legacy.key(f.root, info, f.facts, f.env), pm)
  }
})
test('raw interpolated npmrc is an old-key collision, and neither environment value is now admitted', t => {
  for (const location of ['project', 'user', 'global']) {
    const f = fixture(t)
    const file = location === 'project' ? path.join(f.root, '.npmrc') : f.env[location === 'user' ? 'NPM_CONFIG_USERCONFIG' : 'NPM_CONFIG_GLOBALCONFIG']
    fs.writeFileSync(file, 'omit=${INSTALL_OMIT}\n')
    const before = {...f.env, INSTALL_OMIT: 'optional'}, after = {...f.env, INSTALL_OMIT: 'dev'}
    assert.equal(legacy.key(f.root, f.info, f.facts, before), legacy.key(f.root, f.info, f.facts, after), location)
    for (const env of [before, after]) assert.throws(() => D.key(f.root, f.info, f.facts, env), /environment interpolation/, location)
  }
})
test('only the reviewed npm CLI can answer a restored-tree install', t => {
  const f = fixture(t); restoredTree(f)
  f.bin = path.join(f.base, 'other/npm/bin/npm-cli.js')
  fs.mkdirSync(path.dirname(f.bin), {recursive: true}); fs.writeFileSync(f.bin, '')
  const value = runHook(f)
  assert.deepEqual(value.exits, []); assert.deepEqual(value.listeners, [])
  assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false)
})
test('semantic, path and abbreviated npm arguments cannot skip or record an installation', t => {
  const variants = [['--ignore-scripts', '--no-ignore-scripts'], ['--no-ignore-scripts', '--ignore-scripts'],
    ['--userconfig=./extra.npmrc'], ['--globalconfig', './extra.npmrc'], ['--prefix=../elsewhere'],
    ['--workspace=child'], ['--omit=dev'], ['--prefer-offline'], ['--foreground-scripts'], ['--userc=./extra.npmrc']]
  // These argument orders were equal under the old sorting projection.
  assert.deepEqual(D.npmArgs(variants[0]), D.npmArgs(variants[1]))
  for (const args of variants) {
    const f = fixture(t); restoredTree(f)
    const exits = [], listeners = []
    vm.runInNewContext(install + '; npmCi(' + JSON.stringify(f.bin) + ', ' + JSON.stringify(['ci', ...args]) + ')', {
      __dirname: f.job, require: name => name.endsWith('deps.cjs') ? D : require(name), console,
      process: {version: process.version, execPath: f.facts.bin, env: f.env, cwd: () => f.root,
        exit: code => exits.push(code), on: (...args) => listeners.push(args)},
    })
    assert.deepEqual(exits, [], String(args)); assert.deepEqual(listeners, [], String(args))
    assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false)
  }
  assert.equal(D.npmCiOutputOnly(['--no-audit', '--no-fund', '--loglevel', 'error', '--color=false']), true)
})
test('blank and comment-only configs and reviewed output environment remain eligible', t => {
  const f = fixture(t)
  for (const file of [path.join(f.root, '.npmrc'), f.env.NPM_CONFIG_USERCONFIG,
    f.env.NPM_CONFIG_GLOBALCONFIG, path.join(f.npm, 'npmrc')]) fs.writeFileSync(file, ' \t\r\n# comment\n; comment\n')
  const env = {...f.env, npm_config_audit: 'false', npm_config_loglevel: 'error', npm_config_color: 'false'}
  const key = D.key(f.root, f.info, f.facts, env)
  assert.equal(D.key(f.root, f.info, f.facts, env), key)
})
test('a nested package edit after restore invalidates the install skip', t => {
  const f = fixture(t); restoredTree(f)
  const nested = path.join(f.root, 'node_modules/pkg/lib.js')
  fs.mkdirSync(path.dirname(nested)); fs.writeFileSync(nested, 'before\n')
  f.st.print = D.fullPrint(f.root, f.st.paths)
  fs.writeFileSync(path.join(f.job, 'deps.json'), JSON.stringify(f.st))
  const oldTopPrint = D.treePrint(f.root)
  fs.writeFileSync(nested, 'changed nested package contents\n')
  assert.equal(D.treePrint(f.root), oldTopPrint, 'the old top-level/hidden-lock print misses this edit')
  const value = runHook(f)
  assert.deepEqual(value.exits, []); assert.equal(value.listeners.length, 1)
  assert.match(value.messages.join('\n'), /node_modules changed after Quod restored it/)
  assert.equal(fs.existsSync(path.join(f.job, 'deps-installed.json')), false)
})
