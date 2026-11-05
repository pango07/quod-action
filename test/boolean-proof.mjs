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
function config(valueRead = false, metadata = false, asyncSearch = false) {
  fs.writeFileSync('vitest.config.mjs', `import fs, {readFileSync} from 'node:fs';
import {defineConfig} from 'vitest/config';
const file='package.json';
const exists=${metadata ? 'fs.statSync(file).size > 0' : 'true'};
const pkg=JSON.parse(readFileSync('package.json','utf8'));
${valueRead ? '' : 'const names=Object.keys({...pkg.dependencies,...pkg.devDependencies});'}
export default defineConfig({${asyncSearch ? '' : 'css:{postcss:{}},'}test:{include:exists && ${valueRead ? "pkg.exports?.['./probe'] === './a.js'" : "names.includes('vitest')"} ? ['tests/add.test.js'] : ['tests/*.test.js']}});
`)
}
function clean() {fs.rmSync(ledgerRoot, {recursive:true, force:true})}
function warm() {run('record'); run('witness'); return run('warm')}
function compare(result, label) {assert.deepEqual(result.states, run(label+'-plain', {QUOD_DISABLE:'1'}).states)}
function diagnoseFallback() {
  // A separate, code-hashed diagnostic recording. It never grants replay
  // and does not turn a failed positive assertion into a passing result.
  const code=path.resolve('node_modules/.quod-vitest'), dir=path.join(process.env.RUNNER_TEMP,'boolean-proof-diagnostic')
  fs.mkdirSync(dir,{recursive:true})
  const driver=fs.readFileSync(path.join(code,'driver.mjs'),'utf8').replace("r.keys.add('env:QUOD_VITEST_NAMES_PROOF')", `r.observeRead=(kind,p)=>{if(p===process.cwd()+'/package.json')console.error('MANIFEST_READ',kind,new Error().stack)};
r.keys.add('env:QUOD_VITEST_NAMES_PROOF')`)
  const recorder=fs.readFileSync(path.join(code,'record.mjs'),'utf8').replace('export function settledKeys(r) {', `export function settledKeys(r) {
for(const [p,n] of r.pjReads)if(p===process.cwd()+'/package.json')console.error('MANIFEST_COUNTS',JSON.stringify({p,reads:n,parsed:r.pjParsed.get(p),keys:[...r.keys].filter(k=>k.includes(p))}));`)
  fs.writeFileSync(path.join(dir,'driver.mjs'),driver)
  fs.writeFileSync(path.join(dir,'record.mjs'),recorder)
  clean() // Diagnose actual recorder reads, never an already-provisional plain witness.
  run('diagnose-fallback',{QUOD_VITEST_JS_DIR:dir})
}
try {
  clean(); manifest({'./probe':'./a.js'}); config(); warm()
  manifest({'./probe':'./a-longer-different-value.js'})
  const truth = run('same-truthiness-different-bytes-and-size')
  if (!/1 recorded files: 1 replay, 0 to run/.test(truth.log)) diagnoseFallback()
  assert.match(truth.log, /1 recorded files: 1 replay, 0 to run/)
  compare(truth, 'same-truthiness')
  const off = run('switch-off', {QUOD_VITEST_BOOLEAN_PROOF:'0'})
  assert.doesNotMatch(off.log, /1 recorded files: 1 replay, 0 to run/)
  compare(off, 'switch-off')
  // Restore a trusted, enabled baseline so the shape check cannot pass
  // merely because the opt-in environment input changed.
  run('switch-back-record'); run('switch-back-witness')
  assert.match(run('switch-back-warm').log, /1 recorded files: 1 replay, 0 to run/)
  manifest(undefined)
  const absent = run('exports-removed')
  assert.doesNotMatch(absent.log, /1 recorded files: 1 replay, 0 to run/)
  compare(absent, 'exports-removed')

  // Vite's default async PostCSS search passes raw manifest text to a
  // configurable loader. Its read is not certified by the bounded proof.
  // Preserve this real fallback, alongside the isolated positive case.
  clean(); manifest({'./probe':'./a.js'}); config(false, false, true); warm()
  manifest({'./probe':'./longer-file-name.js'})
  const asyncRead = run('async-loader-keeps-whole-manifest')
  assert.doesNotMatch(asyncRead.log, /1 recorded files: 1 replay, 0 to run/)
  compare(asyncRead, 'async-loader-keeps-whole-manifest')

  clean(); manifest({'./probe':'./a.js'}); config(true); warm()
  manifest({'./probe':'./b.js'})
  const value = run('exports-value-changes-selection')
  assert.equal(value.states.length, 2)
  compare(value, 'exports-value-changes-selection')

  clean(); manifest({'./probe':'./a.js'}); config(false, true); warm()
  manifest({'./probe':'./longer-file-name.js'})
  const metadata = run('stat-size-read-retains-input')
  assert.doesNotMatch(metadata.log, /1 recorded files: 1 replay, 0 to run/)
  compare(metadata, 'stat-size-read-retains-input')
  console.log('Packaged boolean proof: certified truthiness replays; async raw reads, value/shape changes and disabled proof execute; all per-test states agree.')
} finally {
  fs.writeFileSync('package.json', original)
  fs.rmSync('vitest.config.mjs', {force:true})
}
