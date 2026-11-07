'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {spawnSync} = require('node:child_process')
function fixture(t, dispatcher) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-managed-bridge-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const runtime = path.join(root, 'runtime'), marker = path.join(root, 'ordinary-executed')
  fs.mkdirSync(runtime)
  if (dispatcher !== null) fs.writeFileSync(path.join(runtime, 'dispatcher.mjs'), dispatcher)
  const entry = path.join(root, 'vitest.mjs'), config = path.join(root, 'config.json')
  fs.writeFileSync(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0)\n`)
  fs.writeFileSync(config, JSON.stringify({root, managed: {runtime, mode: 'v0', namespace: ''}}))
  const command = spawnSync(process.execPath, [path.join(__dirname, 'managed-bridge.js'), config, entry, 'run'],
    {env: {...process.env, QUOD_SHIM_ACTIVE: '1'}, encoding: 'utf8', timeout: 10000})
  assert(!command.error, command.error?.message)
  return {command, marker}
}
test('late dispatcher errors fail without retrying an observed failure into success', t => {
  const {command, marker} = fixture(t, 'export async function dispatchManaged(){throw new Error("late report failure")}\n')
  assert.equal(command.status, 1)
  assert.equal(fs.existsSync(marker), false)
  assert.match(command.stderr, /dispatcher stopped/)
})
test('an unavailable dispatcher lets the original ordinary command execute', t => {
  const {command, marker} = fixture(t, null)
  assert.equal(command.status, 0)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran')
})
