// Packaged Action regression: changing only an environment value must not
// reuse a pass when the test reads that value through a property descriptor.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const config = 'vitest.config.mjs'
const fixture = 'tests/env-descriptor.test.js'
const originalConfig = fs.existsSync(config) ? fs.readFileSync(config) : null
assert.equal(fs.existsSync(fixture), false, 'fixture must not replace an existing test')
const logs = path.join(process.env.RUNNER_TEMP, 'env-descriptor-logs')
const report = path.join(process.env.RUNNER_TEMP, 'env-descriptor-report.json')
fs.mkdirSync(logs, {recursive:true})
const runs = []
function run(label, value, plain = false) {
  // The preload adds this output path to Vitest's arguments, which are
  // part of the cache key. Keep it constant across the warm-up and mutation.
  fs.rmSync(report, {force:true})
  const env = {...process.env,
    CACHE_DESCRIPTOR_INPUT:value,
    QUOD_VITEST_LINEAGE:'0', QUOD_VITEST_TIMING:'off',
    QUOD_VITEST_NAMES_PROOF:'0', QUOD_VITEST_BOOLEAN_PROOF:'0',
    QUOD_DISABLE:plain ? '1' : '0',
    NODE_OPTIONS:`--require=${process.env.RUNNER_TEMP}/bench-vitest-report.cjs`,
    BENCH_VITEST_REPORT:report}
  delete env.QUOD_VITEST_JS_DIR
  const out = spawnSync('npm', ['test'], {encoding:'utf8', timeout:90000, env})
  const log = (out.stdout ?? '') + (out.stderr ?? '')
  fs.writeFileSync(path.join(logs, `${label}.log`), log)
  assert.equal(out.error, undefined)
  assert.ok(out.status === 0 || out.status === 1, log)
  fs.copyFileSync(report, path.join(logs, `${label}-report.json`))
  const states = JSON.parse(fs.readFileSync(report)).testResults.flatMap(f =>
    f.assertionResults.map(a => [a.fullName, a.status])).sort()
  assert.equal(states.length, 2, 'both descriptor tests must be reported')
  const row = {label, exit:out.status, states}
  runs.push(row)
  fs.writeFileSync(path.join(logs, 'runs.json'), JSON.stringify(runs, null, 2)+'\n')
  return {...row, log}
}
try {
  fs.writeFileSync(config, `export default {css:{postcss:{}},test:{include:['${fixture}'],maxWorkers:1}};\n`)
  fs.writeFileSync(fixture, `import {test,expect} from 'vitest';
test('Object descriptor value',()=>expect(Object.getOwnPropertyDescriptor(process.env,'CACHE_DESCRIPTOR_INPUT').value).toBe('before'));
test('Reflect descriptor value',()=>expect(Reflect.getOwnPropertyDescriptor(process.env,'CACHE_DESCRIPTOR_INPUT').value).toBe('before'));
`)
  fs.rmSync(path.join(process.env.RUNNER_TEMP, 'quod/vitest'), {recursive:true, force:true})
  const baseline = run('plain-before', 'before', true)
  assert.equal(baseline.exit, 0)
  assert.ok(baseline.states.every(([,s]) => s === 'passed'))
  for (const label of ['record', 'witness', 'warm']) {
    const result = run(label, 'before')
    assert.equal(result.exit, 0, result.log)
    assert.deepEqual(result.states, baseline.states)
    if (label === 'warm') assert.match(result.log, /1 recorded files: 1 replay, 0 to run/)
  }
  const changed = run('changed-quod', 'after')
  const plain = run('changed-plain', 'after', true)
  assert.equal(plain.exit, 1, plain.log)
  assert.ok(plain.states.every(([,s]) => s === 'failed'))
  assert.equal(changed.exit, plain.exit, changed.log)
  assert.deepEqual(changed.states, plain.states)
  assert.doesNotMatch(changed.log, /1 recorded files: 1 replay, 0 to run/)
  console.log('Packaged environment descriptor: unchanged input replays; value-only change reruns and matches both plain failures.')
} finally {
  fs.rmSync(fixture, {force:true})
  if (originalConfig === null) fs.rmSync(config, {force:true})
  else fs.writeFileSync(config, originalConfig)
}
