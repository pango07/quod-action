// Linux packaged-action gate only. Every changed selection is checked
// against plain Vitest, including switch-off and mixed value consumers.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const original = fs.readFileSync('package.json', 'utf8')
const ledgerRoot = path.join(process.env.RUNNER_TEMP, 'quod/vitest')
const report = path.join(process.env.RUNNER_TEMP, 'boolean-proof-report.json')
const logDir = path.join(process.env.RUNNER_TEMP, 'boolean-proof-logs')
fs.mkdirSync(logDir, {recursive:true})
let counter = 0
function run(label, extra = {}) {
  fs.rmSync(report, {force:true})
  const out = spawnSync('npm', ['test'], {encoding:'utf8', timeout:90000, env:{...process.env,
    QUOD_VITEST_NAMES_PROOF:'1', QUOD_VITEST_BOOLEAN_PROOF:'1', QUOD_VITEST_LINEAGE:'0', QUOD_VITEST_TIMING:'off',
    NODE_OPTIONS:`--require=${process.env.RUNNER_TEMP}/bench-vitest-report.cjs`, BENCH_VITEST_REPORT:report, ...extra}})
  const log = (out.stdout ?? '') + (out.stderr ?? '')
  fs.writeFileSync(path.join(logDir, `${counter++}-${label}.log`), log)
  assert.equal(out.status, 0, log || String(out.error))
  const states = JSON.parse(fs.readFileSync(report)).testResults.flatMap(f =>
    f.assertionResults.map(a => [path.basename(f.name), a.fullName, a.status])).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  assert.ok(states.length, `missing test evidence: ${label}`)
  console.log(label, JSON.stringify(states))
  return {states, log}
}
function manifest(exports) {
  const pkg = JSON.parse(original)
  if (exports !== undefined) pkg.exports = exports
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')
}
function config(valueRead = false, stat = false) {
  fs.writeFileSync('vitest.config.mjs', `import fs from 'node:fs';
import {defineConfig} from 'vitest/config';
function tryStatSync(file) {try {return fs.statSync(file, {throwIfNoEntry:false});} catch {}}
const file='package.json';
const exists=${stat ? 'tryStatSync(file)?.isFile()' : 'true'};
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const one=exists && ${valueRead ? "pkg.exports?.['./probe'] === './a.js'" : '!!pkg.exports'};
export default defineConfig({test:{include:one ? ['tests/add.test.js'] : ['tests/*.test.js']}});
`)
}
function clean() {fs.rmSync(ledgerRoot, {recursive:true, force:true})}
function warm() {run('record'); run('witness'); return run('warm')}
function compare(result, label) {assert.deepEqual(result.states, run(label+'-plain', {QUOD_DISABLE:'1'}).states)}
try {
  clean(); manifest({'./probe':'./a.js'}); config(false, true); warm()
  manifest({'./probe':'./a-longer-different-value.js'})
  const truth = run('same-truthiness-different-bytes-and-size')
  assert.match(truth.log, /1 recorded files: 1 replay, 0 to run/)
  compare(truth, 'same-truthiness')
  const off = run('switch-off', {QUOD_VITEST_BOOLEAN_PROOF:'0'})
  assert.doesNotMatch(off.log, /1 recorded files: 1 replay, 0 to run/)
  compare(off, 'switch-off')
  manifest(undefined)
  const absent = run('exports-removed')
  assert.equal(absent.states.length, 2)
  compare(absent, 'exports-removed')

  clean(); manifest({'./probe':'./a.js'}); config(true); warm()
  manifest({'./probe':'./b.js'})
  const value = run('exports-value-changes-selection')
  assert.equal(value.states.length, 2)
  compare(value, 'exports-value-changes-selection')
  console.log('Packaged boolean proof: equal truthiness replays, value/shape changes and disabled proof execute; all per-test states agree.')
} finally {
  fs.writeFileSync('package.json', original)
  fs.rmSync('vitest.config.mjs', {force:true})
}
