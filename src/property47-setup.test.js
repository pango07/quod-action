'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const vm = require('node:vm')
const {execFileSync} = require('node:child_process')
const {captureCacheAuth, loadCacheAuth} = require('./managed-auth')

// Exercise the real setup functions with a tiny materialized archive. Its
// placeholder modules are never imported and provide no runtime/test authority.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const setup = source.slice(source.indexOf('async function vitest(mode)'), source.indexOf('\nrun()'))
const modes = ['v0', 'control', 'matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']

function fixture(t, {mode, profileModule = true} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-property47-setup-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const dist = path.join(base, 'dist'), input = path.join(base, 'runtime-input'), project = path.join(base, 'project')
  const paths = {base: path.join(base, 'job')}
  paths.config = path.join(paths.base, 'config.json'); paths.reports = path.join(paths.base, 'reports')
  fs.mkdirSync(paths.base); fs.mkdirSync(project); fs.mkdirSync(input)
  for (const name of ['main', 'managed', 'managed-bridge', 'matrix-bridge']) fs.mkdirSync(path.join(dist, name), {recursive: true})
  for (const name of ['main', 'managed-bridge', 'matrix-bridge']) fs.writeFileSync(path.join(dist, name, 'index.js'), '')
  const names = ['dispatcher.mjs', 'matrix-input-dispatcher.mjs', 'resolved-compile-certificate.mjs',
    'matrix-candidate-envelope.mjs', 'matrix-receipt.mjs', 'matrix-native.mjs',
    ...(profileModule ? ['matrix-candidate-profiles.mjs'] : [])]
  for (const name of names) fs.writeFileSync(path.join(input, name), '// unit placeholder; never imported\n')
  const archive = path.join(dist, 'managed/runtime.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', input, '.'])
  const manifest = {schema: 'quod-managed-action-runtime-v1',
    source: {repository: 'pango07/quod', commit: 'a'.repeat(40)},
    sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}
  fs.writeFileSync(path.join(dist, 'managed/manifest.json'), JSON.stringify(manifest))
  const environment = {GITHUB_WORKSPACE: project, ACTIONS_RUNTIME_TOKEN: 'fixture-not-service-auth'}
  const inputs = {'managed-vitest': mode, 'managed-epoch': '1700000000000', 'managed-seed': '42',
    'managed-env': '{"NODE_ENV":"test"}', 'cache-namespace': 'fixture'}
  const states = new Map(), secrets = []
  const run = () => vm.runInNewContext(setup + '\nvitest("check")', {
    fs, path, crypto, execFileSync, paths, scope: () => ({trusted: true}), maySave: () => true,
    captureCacheAuth: file => captureCacheAuth(file, environment),
    process: {platform: 'linux', arch: 'x64', argv: [process.execPath, path.join(dist, 'main/index.js')], env: environment},
    core: {getInput: name => inputs[name] ?? '', info() {},
      saveState: (name, value) => states.set(name, value), setSecret: value => secrets.push(value)},
  })
  return {base, dist, paths, project, manifest, states, secrets, run}
}

test('all explicit managed modes pass real setup validation and persist their private session and selected bridge', async t => {
  for (const mode of modes) {
    const f = fixture(t, {mode})
    assert.equal(await f.run(), true, mode)
    const config = JSON.parse(fs.readFileSync(f.paths.config, 'utf8')), managed = config.managed
    assert.equal(config.quod, null); assert.equal(config.record, false); assert.equal(config.root, f.project)
    assert.equal(config.mode, 'check'); assert.equal(managed.mode, mode)
    assert.equal(managed.bridge, path.join(f.dist, mode.startsWith('matrix-') ? 'matrix-bridge/index.js' : 'managed-bridge/index.js'))
    assert.equal(managed.runtime, path.join(f.paths.base, 'managed-runtime'))
    assert.equal(managed.archiveSha256, f.manifest.sha256)
    assert.deepEqual(managed.source, f.manifest.source)
    assert.deepEqual(managed.env, {NODE_ENV: 'test'}); assert.equal(managed.epoch, 1700000000000); assert.equal(managed.seed, 42)
    assert.equal(managed.namespace, 'fixture-'); assert.equal(managed.write, true)
    assert.equal(managed.cacheAuth, path.join(f.paths.base, 'managed-cache-auth.json'))
    assert.equal(fs.statSync(managed.cacheAuth).mode & 0o777, 0o600)
    assert.deepEqual(loadCacheAuth(managed.cacheAuth), {ACTIONS_RUNTIME_TOKEN: 'fixture-not-service-auth'})
    assert.equal(fs.statSync(f.paths.config).mode & 0o777, 0o600)
    assert.equal(f.states.get('managed-auth'), managed.cacheAuth)
    assert.equal(f.states.get('managed-matrix'), mode.startsWith('matrix-') ? '1' : undefined)
    assert.deepEqual(f.secrets, ['fixture-not-service-auth'])
  }
})

test('only property modes require the finite selector module before setup creates credentials', async t => {
  for (const mode of modes) {
    const f = fixture(t, {mode, profileModule: false})
    if (mode.startsWith('matrix-property47')) {
      await assert.rejects(f.run(), /managed runtime incomplete/)
      assert.equal(fs.existsSync(path.join(f.paths.base, 'managed-cache-auth.json')), false)
      assert.equal(fs.existsSync(f.paths.config), false)
      assert.equal(f.states.has('managed-auth'), false)
    } else assert.equal(await f.run(), true, mode)
  }
  const invalid = fixture(t, {mode: 'matrix-property47-unknown'})
  await assert.rejects(invalid.run(), /managed-vitest must be/)
  assert.equal(fs.existsSync(path.join(invalid.paths.base, 'managed-cache-auth.json')), false)
  assert.equal(fs.existsSync(invalid.paths.config), false)
})
