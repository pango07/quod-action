import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {ARGS, MARKER, SUITE, json, pins, runIdentity, write} from './product-readiness-common.mjs'

const [directory, cloudDirectory, output] = process.argv.slice(2)
assert(directory && cloudDirectory && output)
const result = {schema: 'quod-product-native-acceptance-v1', passed: false, identity: runIdentity(), checks: []}
const check = (name, predicate) => {assert(predicate, name); result.checks.push({name, passed: true})}
try {
  result.pins = pins()
  const roles = ['plain', 'record', 'witness', 'replay', 'changed', 'fallback']
  const records = Object.fromEntries(roles.map(role => {
    const value = json(path.join(directory, `product-readiness-${role}`, 'result.json'))
    assert.equal(value.schema, 'quod-product-native-role-v1'); assert.equal(value.role, role); assert.equal(value.passed, true)
    assert.deepEqual(value.pins, result.pins)
    assert.equal(value.identity.run, result.identity.run); assert.equal(value.identity.attempt, result.identity.attempt)
    assert.equal(value.identity.sha, result.identity.sha)
    return [role, value]
  }))
  check('six fresh jobs used one exact shipped commit and complete dist byte inventory',
    new Set(Object.values(records).map(value => value.identity.job)).size === 6)
  check('all five Action consumers kept managed and lineage off with default inline recording',
    roles.filter(role => role !== 'plain').every(role => {
      const config = records[role].configuration
      return config.mode === 'check' && config.record === true && config.managed === 'off' && config.lineage === 'off'
    }))
  const plain = records.plain.runs[0]
  check('full native two-file seven-assertion multiset retains both duplicate names and the skipped state',
    plain.report.files.length === 2 && plain.report.tests.length === 7 &&
    plain.report.tests.filter(row => row[1] === 'duplicate assertion name').length === 2 &&
    plain.report.tests.filter(row => ['pending', 'skipped'].includes(row[2])).length === 1)
  for (const role of ['record', 'witness', 'replay', 'fallback']) {
    const observed = records[role].runs[0]
    assert.deepEqual(observed.report, plain.report)
    assert.deepEqual(observed.controlledOutput, [MARKER]); assert.equal(observed.markerCount, 1)
    assert.deepEqual(observed.vitestArgv, ['run', ...ARGS]); assert.equal(observed.exitCode, 0)
  }
  check('record witness replay and outage fallback preserve full native counters names file states controlled console output and exit', true)
  const firstInstall = records.record.installation
  check('the cold record performs a successful real npm ci and leaves the matching install-success marker',
    firstInstall.cache.hit === '' && !firstInstall.actualNpmCiSkipped && firstInstall.realInstallMarker.keyMatched)
  check('fresh successor jobs restore the same exact dependency key and actually skip unchanged npm ci',
    ['witness', 'replay', 'changed', 'fallback'].every(role => {
      const install = records[role].installation
      assert.deepEqual(install.beforeTree, install.afterTree)
      assert.deepEqual(install.beforeTree, firstInstall.afterTree)
      return install.cache.hit === 'exact' && install.cache.key === firstInstall.cache.key && install.actualNpmCiSkipped
    }))
  check('every installed or restored dependency tree matches the complete plain native projection excluding only the root Quod marker',
    roles.every(role => {
      assert.deepEqual(records[role].installation.afterTree.nativeProjection, records.plain.installation.afterTree.nativeProjection)
      return true
    }))
  check('separate recording and independent-witness jobs actually ran both files',
    records.record.runs[0].statistics.ran === 2 && records.witness.runs[0].statistics.ran === 2)
  check('the fresh normal consumer actually replayed a nonempty set', records.replay.runs[0].statistics.replayed > 0)
  check('an unreachable Cloud server uses the existing Actions ledger and still actually replays',
    records.fallback.configuration.cloudConfigured === false && records.fallback.runs[0].statistics.replayed > 0)
  assert.deepEqual(records.changed.runs[0].report, records.changed.runs[1].report)
  check('a changed tracked input fails exactly like its same-command native control and is restored',
    records.changed.runs.length === 2 && records.changed.runs.every(value => value.exitCode === 1) &&
    records.changed.originalInputRestored === true && records.changed.runs[1].statistics.ran >= 1)
  const unsupported = records.fallback.runs.slice(1)
  assert.equal(unsupported.length, 2); assert.deepEqual(unsupported[0].report, unsupported[1].report)
  check('unsupported sharding remains native with complete equal results and no Quod statistics',
    unsupported.every(value => value.unsupported && value.exitCode === 0 && value.statistics === null))
  const cloud = json(path.join(cloudDirectory, 'cloud-readback.json'))
  assert.equal(cloud.schema, 'quod-product-cloud-readback-v1'); assert.equal(cloud.passed, true)
  assert.equal(cloud.identity.run, result.identity.run); assert.equal(cloud.identity.attempt, result.identity.attempt)
  assert.equal(cloud.identity.sha, result.identity.sha)
  assert(!Object.values(records).some(value => value.identity.job === cloud.identity.job))
  assert.deepEqual(cloud.pins, result.pins); assert.equal(cloud.suite, SUITE)
  for (const role of ['witness', 'replay', 'fallback']) assert.deepEqual(records[role].publicScopeEvidence, records.record.publicScopeEvidence)
  assert.deepEqual(cloud.readback.publicScopeEvidence, records.record.publicScopeEvidence)
  assert.deepEqual(cloud.readback.files, plain.report.files); assert.deepEqual(cloud.readback.tests, plain.report.tests)
  check('the shipped binary read a current-commit signed Cloud ledger and all original states into an empty directory',
    cloud.localLedgerFallback === false && cloud.actionExecutedInThisJob === false && cloud.readback.emptyBefore &&
    cloud.readback.verifiedPinnedServerKey && cloud.readback.commit === result.identity.sha)
  check('a wrong valid Ed25519 server key rejects the signed answer without any local ledger',
    cloud.wrongKey.emptyBefore && cloud.wrongKey.signedAnswerRejected && !cloud.wrongKey.ledgerPresentAfter &&
    !cloud.wrongKey.restoreMarkerPresentAfter)
  assert.equal(result.checks.length, 14)
  result.roles = records
  result.cloudReadback = cloud
  result.limitations = ['synthetic generic native fixture only', 'coverage not exercised', 'complete job and post durations require Actions API',
    'no full-suite workload or 50 percent cost claim', 'no managed execution or lineage promotion exercised',
    'scope-state encoding is supplied by the exact shipped engine; signed transport is checked independently',
    'Cloud inability to authorize this public repository is a gate failure, not a skipped proof']
  result.passed = true
} catch (error) {
  result.error = {name: error.name, message: String(error.message).slice(0, 1000)}
  process.exitCode = 1
} finally {write(path.join(output, 'acceptance.json'), result)}
