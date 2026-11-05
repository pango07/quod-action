// Run only in the GitHub packaged-action gate, from test/. No local builds.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const original = fs.readFileSync('package.json', 'utf8')
const ledgerRoot = path.join(process.env.RUNNER_TEMP, 'quod/vitest')
const report = path.join(process.env.RUNNER_TEMP, 'names-proof-report.json')
const logDir = path.join(process.env.RUNNER_TEMP, 'names-proof-logs')
fs.mkdirSync(logDir, { recursive:true })
const namesConfig = `import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitest/config';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const names = Object.keys({...pkg.dependencies, ...pkg.devDependencies});
export default defineConfig({test:{include:names.includes('probe-more') ? ['tests/*.test.js'] : ['tests/add.test.js']}});
`
const valueConfig = `import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitest/config';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const names = Object.keys({...pkg.dependencies, ...pkg.devDependencies});
export default defineConfig({test:{include:pkg.devDependencies['probe-unused'] === '1' ? ['tests/add.test.js'] : ['tests/*.test.js']}});
`
let counter = 0
function run(label, extra = {}) {
  fs.rmSync(report, {force:true})
  const out = spawnSync('npm', ['test'], {encoding:'utf8', timeout:90000, env:{...process.env,
    QUOD_VITEST_NAMES_PROOF:'1', QUOD_VITEST_LINEAGE:'0', QUOD_VITEST_TIMING:'off',
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
function manifest(version, more = false) {
  const pkg = JSON.parse(original)
  pkg.devDependencies['probe-unused'] = version
  if (more) pkg.devDependencies['probe-more'] = '1'
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')
}
function clean() { fs.rmSync(ledgerRoot, {recursive:true, force:true}) }
function warm() { run('record'); run('witness'); return run('warm') }
function compare(result, label) { assert.deepEqual(result.states, run(label+'-plain', {QUOD_DISABLE:'1'}).states) }
try {
  clean(); manifest('1'); fs.writeFileSync('vitest.config.mjs', namesConfig)
  warm()
  manifest('2')
  const version = run('discarded-version-change')
  assert.match(version.log, /1 recorded files: 1 replay, 0 to run/)
  compare(version, 'discarded-version-change')
  const off = run('switch-off', {QUOD_VITEST_NAMES_PROOF:'0'})
  assert.doesNotMatch(off.log, /1 recorded files: 1 replay, 0 to run/)
  compare(off, 'switch-off')
  manifest('2', true)
  const added = run('added-dependency-name')
  assert.equal(added.states.length, 2)
  compare(added, 'added-dependency-name')

  clean(); manifest('1'); fs.writeFileSync('vitest.config.mjs', valueConfig)
  warm()
  manifest('2')
  const branch = run('version-dependent-selection')
  assert.equal(branch.states.length, 2)
  compare(branch, 'version-dependent-selection')
  console.log('Packaged configuration proof: ignored values replay; name changes, disabled proof, and value branches execute; per-test states agree.')
} finally {
  fs.writeFileSync('package.json', original)
  fs.rmSync('vitest.config.mjs', {force:true})
}
