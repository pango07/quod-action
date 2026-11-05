// Packaged Linux gate: upgrades must observe again, not witness or replay
// dependencies collected by an older recorder.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const root = path.join(process.env.RUNNER_TEMP, 'quod/vitest')
const logs = path.join(process.env.RUNNER_TEMP, 'recorder-upgrade-logs')
const report = path.join(process.env.RUNNER_TEMP, 'recorder-upgrade-report.json')
fs.mkdirSync(logs, {recursive:true})
let count = 0
function run(label, extra = {}) {
  fs.rmSync(report, {force:true})
  const out = spawnSync('npm', ['test'], {encoding:'utf8', timeout:90000, env:{...process.env,
    QUOD_VITEST_LINEAGE:'0', QUOD_VITEST_TIMING:'off',
    NODE_OPTIONS:`--require=${process.env.RUNNER_TEMP}/bench-vitest-report.cjs`, BENCH_VITEST_REPORT:report, ...extra}})
  const log = (out.stdout ?? '') + (out.stderr ?? '')
  fs.writeFileSync(path.join(logs, `${count++}-${label}.log`), log)
  assert.equal(out.status, 0, log || String(out.error))
  const states = JSON.parse(fs.readFileSync(report)).testResults.flatMap(f =>
    f.assertionResults.map(a => [path.basename(f.name), a.fullName, a.status])).sort()
  assert.equal(states.length, 2, 'both test results must be present')
  return {states, log}
}
function ledger() {
  const files = fs.readdirSync(root).map(d => path.join(root,d,'ledger.json')).filter(p => fs.existsSync(p))
  assert.equal(files.length, 1)
  return {file:files[0], data:JSON.parse(fs.readFileSync(files[0]))}
}
function recordedAgain(result) {
  assert.match(result.log, /0 recorded files: 0 replay/)
  const data = ledger().data
  assert.ok(data.code, 'ledger must bind its recorder')
  assert.equal(Object.keys(data.files).length, 2)
  for (const r of Object.values(data.files)) {
    assert.equal(r.plain_n, 0, 'old plain trust must not survive')
    assert.equal(r.w.n, 1, 'new recording needs its own witness')
    assert.equal(r.promotion_stamp, null)
  }
  return data.code
}

fs.rmSync(root, {recursive:true, force:true})
const first = run('record')
const code = recordedAgain(first)
run('witness')
assert.match(run('warm').log, /2 recorded files: 2 replay, 0 to run/)
assert.ok(Object.values(ledger().data.files).every(r => r.plain_n >= 1))

const override = path.join(process.env.RUNNER_TEMP, 'recorder-upgrade-source')
fs.mkdirSync(override, {recursive:true})
fs.writeFileSync(path.join(override,'driver.mjs'), '// Recorder upgrade regression\n' +
  fs.readFileSync('node_modules/.quod-vitest/driver.mjs','utf8'))
const upgraded = run('different-code', {QUOD_VITEST_JS_DIR:override})
assert.notEqual(recordedAgain(upgraded), code)
assert.deepEqual(upgraded.states, first.states)
assert.equal(recordedAgain(run('switch-back')), code)

// A serialized ledger from before the code field existed is equally unsafe.
run('switch-back-witness')
assert.match(run('switch-back-warm').log, /2 recorded files: 2 replay, 0 to run/)
const legacy = ledger()
delete legacy.data.code
fs.writeFileSync(legacy.file, JSON.stringify(legacy.data))
const restored = run('legacy-ledger')
assert.equal(recordedAgain(restored), code)
assert.deepEqual(restored.states, run('plain', {QUOD_DISABLE:'1'}).states)
console.log('Recorder upgrade, downgrade and legacy ledgers all record anew; per-test states agree with plain.')
