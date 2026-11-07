'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')

function invoke(t, {nested = false, error = false, code = 0} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-managed-hook-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project'), pkg = path.join(root, 'node_modules/vitest')
  fs.mkdirSync(pkg, {recursive: true})
  fs.mkdirSync(path.join(root, 'nested'))
  const entry = path.join(pkg, 'vitest.mjs'), quod = path.join(base, 'quod')
  fs.writeFileSync(entry, ''); fs.writeFileSync(quod, '')
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"5.0.0"}')
  const bridge = path.join(base, 'managed-bridge.js')
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({root, quod, mode: 'check', managed: {bridge}}))
  const calls = [], stopped = {}, args = ['run', '--reporter=json', '--outputFile.json=report with spaces.json']
  let exit
  try {
    vm.runInNewContext(source, {__dirname: base, console: {error() {}},
      require: name => name === 'node:child_process' ? {spawnSync(command, argv, options) {
        calls.push({command, argv: Array.from(argv), options})
        return error ? {error: new Error('missing bridge')} : {status: code}
      }} : require(name),
      process: {argv: [process.execPath, entry, ...args], execPath: process.execPath,
        env: {CI: '1'}, versions: {}, cwd: () => nested ? path.join(root, 'nested') : root,
        exit(value) { exit = value; throw stopped }}})
  } catch (error) { if (error !== stopped) throw error }
  return {calls, exit, args, entry, bridge, base}
}
test('managed opt-in forwards the original Vitest argv and preserves failures', t => {
  const result = invoke(t, {code: 1})
  assert.equal(result.exit, 1)
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].command, process.execPath)
  assert.deepEqual(result.calls[0].argv, [result.bridge, path.join(result.base, 'config.json'), result.entry, ...result.args])
  assert.equal(result.calls[0].options.env.QUOD_SHIM_ACTIVE, '1')
})
test('a package-local invocation retains its original ordinary selection', t => {
  const result = invoke(t, {nested: true})
  assert.equal(result.calls.length, 0)
  assert.equal(result.exit, undefined)
})
test('failure to start the managed bridge leaves Vitest to execute normally', t => {
  const result = invoke(t, {error: true})
  assert.equal(result.calls.length, 1)
  assert.equal(result.exit, undefined)
})
