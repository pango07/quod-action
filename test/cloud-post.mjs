// Exercise the actual ncc post bundle: it must await Cloud publication
// before removing its config, including when a child exits unsuccessfully.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const post = fileURLToPath(new URL('../dist/post/index.js', import.meta.url))
const activeConfig = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'quod/config.json')))
assert.equal(activeConfig.deferCloudSave, true, 'the packaged main must enable its matching post bundle')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-bundled-cloud-post-'))
try {
  for (const exitCode of [0, 3]) {
    const runnerTemp = path.join(temp, String(exitCode))
    const base = path.join(runnerTemp, 'quod'), ledgers = path.join(base, 'vitest')
    const dir = path.join(ledgers, 'package'), config = path.join(base, 'config.json')
    const executable = path.join(base, 'fake-quod'), received = path.join(base, 'received.json')
    const suite = 'package with spaces; $(echo literal-argument)'
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(ledgers, '.suites'))
    fs.mkdirSync(path.join(base, 'cloud-recorded'))
    fs.writeFileSync(path.join(dir, 'ledger.json'), '{}')
    fs.writeFileSync(path.join(ledgers, '.suites/package'), suite)
    fs.writeFileSync(path.join(base, 'cloud-recorded/package'), '')
    fs.writeFileSync(path.join(base, 'recorded'), '')
    fs.writeFileSync(config, JSON.stringify({ root: base, quod: executable, ledgers, cloud: {}, deferCloudSave: true }))
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' +
      'setTimeout(() => {\n' +
      '  const fs = require("node:fs");\n' +
      '  fs.writeFileSync(' + JSON.stringify(received) + ', JSON.stringify({\n' +
      '    args: process.argv.slice(2), cwd: process.cwd(), active: process.env.QUOD_SHIM_ACTIVE,\n' +
      '    configPresent: fs.existsSync(' + JSON.stringify(config) + ')\n' +
      '  }));\n' +
      '  process.exit(' + exitCode + ');\n' +
      '}, 150);\n')
    fs.chmodSync(executable, 0o755)
    const env = { ...process.env, RUNNER_TEMP: runnerTemp, QUOD_SHIM_ACTIVE: '1' }
    // Do not inherit the surrounding Action's saved state or dependency
    // cache instructions: this isolated fixture never calls the network.
    for (const k of Object.keys(env)) if (k.startsWith('STATE_')) delete env[k]
    Object.assign(env, { STATE_active: '1', STATE_vitest: '1', STATE_mode: 'check', STATE_record: '1', STATE_hit: 'exact', STATE_key: 'fixture' })
    const result = spawnSync(process.execPath, [post], { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || String(result.error))
    const got = JSON.parse(fs.readFileSync(received))
    assert.deepEqual(got.args, ['vitest', '--dir', dir, '--cloud', '--suite', suite, '--cloud-only', 'save'])
    assert.equal(got.cwd, base)
    assert.equal(got.active, '1')
    assert.equal(got.configPresent, true, 'credentials must remain until the save child exits')
    assert.equal(fs.existsSync(config), false, 'post must clean up credentials after the child exits')
    assert.equal(fs.existsSync(path.join(base, 'cloud-recorded/package')), exitCode !== 0)
    if (exitCode === 0) assert.match(result.stdout, /finished 1 deferred Cloud ledger save/)
    else assert.match(result.stdout, /Cloud ledger save exited 3/)
  }
  console.log('Packaged main/post defer Cloud saves, preserve literal suite names, await children and clean up config on success and failure.')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
