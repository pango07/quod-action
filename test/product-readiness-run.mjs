import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {ARGS, MARKER, configuration, fixture, json, ledgerDirectory, pins, publicScopeEvidence, report, runIdentity, sha, summary, summaryFile, write} from './product-readiness-common.mjs'

const [role, output] = process.argv.slice(2)
assert(['plain', 'record', 'witness', 'replay', 'changed', 'fallback'].includes(role) && output)
const result = {schema: 'quod-product-native-role-v1', role, identity: runIdentity(), passed: false, runs: []}
try {
  result.pins = pins()
  result.installation = json(path.join(output, 'installation.json'))
  assert.equal(result.installation.passed, true); assert.equal(result.installation.role, role)
  if (role !== 'plain') result.configuration = configuration(role !== 'fallback')
  const execute = ({disable = false, unsupported = false, failing = false} = {}) => {
    fs.rmSync(path.join(fixture(), 'product-report.json'), {force: true})
    fs.rmSync(summaryFile(), {force: true})
    const args = ['test', ...(unsupported ? ['--', '--shard=1/1'] : [])]
    const env = {...process.env, PRODUCT_INPUT: '7'}
    assert.equal(env.PRODUCT_WITNESS_SCOPE, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
    if (disable) env.QUOD_DISABLE = '1'
    else delete env.QUOD_DISABLE
    const child = spawnSync('npm', args, {cwd: fixture(), env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024})
    assert(!child.error && child.signal === null, 'test command must settle normally inside its bound')
    assert.equal(child.status, failing ? 1 : 0)
    const outputText = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
    const markerCount = outputText.split(MARKER).length - 1
    assert.equal(markerCount, 1, 'exact controlled output must appear once')
    const normalized = report(json(path.join(fixture(), 'product-report.json')))
    assert.equal(normalized.success, !failing)
    const native = role === 'plain' || disable || unsupported
    assert.equal(fs.existsSync(summaryFile()), !native, 'only an intercepted ordinary run may emit Quod statistics')
    if (native) assert(!outputText.includes('quod vitest:'), 'unsupported/disabled commands must remain native')
    const run = {argv: ['npm', ...args], vitestArgv: ['run', ...ARGS, ...(unsupported ? ['--shard=1/1'] : [])],
      disabled: disable, unsupported, exitCode: child.status, controlledOutput: [MARKER], markerCount,
      report: normalized, capturedOutputSha256: sha(outputText), statistics: native ? null : summary()}
    result.runs.push(run)
    return run
  }
  if (role === 'changed') {
    const input = path.join(fixture(), 'data/value.txt'), original = fs.readFileSync(input)
    assert.equal(original.toString(), '9\n')
    try {
      fs.writeFileSync(input, '10\n')
      const control = execute({disable: true, failing: true}), observed = execute({failing: true})
      assert.deepEqual(observed.report, control.report)
      assert(observed.statistics.ran >= 1 && observed.statistics.replayed <= 1,
        'the affected tracked-input file must run and retain its actual failing state')
    } finally {fs.writeFileSync(input, original)}
    assert.equal(fs.readFileSync(input).toString(), '9\n')
    result.originalInputRestored = true
  } else {
    const observed = execute({disable: role === 'plain'})
    if (role === 'record' || role === 'witness') assert.equal(observed.statistics.ran, 2, 'first record and independent witness must actually run both files')
    if (role === 'replay' || role === 'fallback') assert(observed.statistics.replayed > 0, 'a fresh consumer must actually replay')
    if (role === 'fallback') {
      const control = execute({disable: true, unsupported: true}), native = execute({unsupported: true})
      assert.deepEqual(native.report, control.report)
      assert.deepEqual(native.controlledOutput, control.controlledOutput)
    }
    if (role !== 'plain') result.publicScopeEvidence = publicScopeEvidence(json(path.join(ledgerDirectory(), 'ledger.json')))
  }
  result.passed = true
} catch (error) {
  // Fixed diagnostic text only: never publish CLI output, config or credential values.
  result.error = {name: error.name, message: String(error.message).slice(0, 1000)}
  process.exitCode = 1
} finally {write(path.join(output, 'result.json'), result)}
