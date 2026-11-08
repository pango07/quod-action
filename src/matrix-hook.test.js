'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')

function invoke(t, {args = ['run'], mode = 'matrix-research', version = '5.0.0', nested = false,
  consumed = false, status = 0, childError = false} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-matrix-hook-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project'), pkg = path.join(root, 'node_modules/vitest')
  fs.mkdirSync(pkg, {recursive: true}); fs.mkdirSync(path.join(root, 'nested'))
  const entry = path.join(pkg, 'vitest.mjs'), session = path.join(base, 'managed-cache-auth.json')
  fs.writeFileSync(entry, ''); fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({version}))
  if (!consumed) fs.writeFileSync(session, '{}', {mode: 0o600})
  const bridge = path.join(base, 'matrix-bridge.js')
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({root, mode: 'check', managed: {mode, bridge, cacheAuth: session}}))
  const calls = [], stop = {}; let exit
  try {
    vm.runInNewContext(hook, {__dirname: base, console: {error() {}},
      require: name => name === 'node:child_process' ? {spawnSync(command, argv, options) {
        calls.push({command, argv: Array.from(argv), options})
        return childError ? {error: new Error('unavailable bridge')} : {status}
      }} : require(name),
      process: {argv: [process.execPath, entry, ...args], execPath: process.execPath,
        env: {CI: '1'}, versions: {}, cwd: () => nested ? path.join(root, 'nested') : root,
        exit(code) {exit = code; throw stop}}})
  } catch (error) {if (error !== stop) throw error}
  return {base, bridge, entry, session, calls, exit}
}
test('explicit matrix modes forward only exact default root run and preserve child failure', t => {
  for (const mode of ['matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']) {
    const f = invoke(t, {mode, status: 1})
    assert.equal(f.exit, 1); assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].argv, [f.bridge, path.join(f.base, 'config.json'), f.entry, 'run'])
    assert.equal(f.calls[0].options.env.QUOD_SHIM_ACTIVE, '1')
  }
})
test('reporters, filters, watch, other versions and nested invocations remain ordinary and consume the setup session', t => {
  const declined = [
    {args: ['run', '--reporter=json']}, {args: ['run', '--outputFile=x.json']},
    {args: ['run', 'one.test.ts']}, {args: ['run', '--project=zod-4.0']},
    {args: ['run', '--coverage']}, {args: ['watch']}, {args: []},
    {version: '5.0.1'}, {version: '6.0.0'}, {nested: true},
  ]
  for (const mode of ['matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']) for (const options of declined) {
    const f = invoke(t, {...options, mode})
    assert.equal(f.calls.length, 0, JSON.stringify(options)); assert.equal(f.exit, undefined)
    assert.equal(fs.existsSync(f.session), false)
  }
})
test('a consumed session makes later root commands ordinary; inability to spawn a bridge remains ordinary', t => {
  for (const mode of ['matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']) {
    const later = invoke(t, {mode, consumed: true})
    assert.equal(later.calls.length, 0); assert.equal(later.exit, undefined)
    const failed = invoke(t, {mode, childError: true})
    assert.equal(failed.calls.length, 1); assert.equal(failed.exit, undefined)
    assert.equal(fs.existsSync(failed.session), false)
  }
})
