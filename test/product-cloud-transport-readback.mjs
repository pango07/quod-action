// Remote-only transport proof. This does not prove test replay or witness promotion.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {ARCHIVE_SHA, BINARY_SHA, SERVER, SERVER_KEY, SUITE, fixture, pins, publicScopeEvidence, runIdentity, sha, workspace, write} from './product-readiness-common.mjs'

const [output, coldRecordFile, ...extra] = process.argv.slice(2)
assert(output && coldRecordFile && extra.length === 0)
const PROOF_REF = 'refs/heads/exp/product-native-readiness-sol-ultra'
const EXPECTED_FILES = ['tests/inputs.test.js', 'tests/math.test.js']
const sort = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const result = {schema: 'quod-product-cloud-transport-readback-v1', proof: 'authenticated-same-ref-ledger-transport-only',
  passed: false, identity: runIdentity(), suite: SUITE, archiveSha256: ARCHIVE_SHA,
  localLedgerFallback: false, actionExecutedInThisJob: false, replayProven: false, witnessPromotionProven: false}
let stage = 'initialization', temporary

function read(file, maximum) {
  assert.equal(fs.realpathSync(path.dirname(file)), path.resolve(path.dirname(file)))
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    assert(before.isFile() && before.size > 0 && before.size <= maximum)
    const buffer = Buffer.alloc(maximum + 1)
    let size = 0, count
    do {count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count} while (count && size < buffer.length)
    const after = fs.fstatSync(fd)
    assert(size === before.size && size <= maximum && after.size === before.size && after.mtimeMs === before.mtimeMs)
    return buffer.subarray(0, size)
  } finally {fs.closeSync(fd)}
}
const readJson = (file, maximum) => JSON.parse(read(file, maximum).toString('utf8'))

try {
  stage = 'source-and-oidc-preconditions'
  result.pins = pins()
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(process.env.GITHUB_REF, PROOF_REF)
  assert(!process.env.QUOD_SERVER_TOKEN, 'only actual job OIDC is accepted')
  for (const name of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) assert(process.env[name])
  assert(!fs.existsSync(path.join(process.env.RUNNER_TEMP, 'quod/config.json')))
  assert(!fs.existsSync(path.join(process.env.RUNNER_TEMP, 'quod/vitest')))
  result.auth = {method: 'github-oidc', event: 'workflow_dispatch', ref: PROOF_REF, trustedWriterClaimed: false}

  stage = 'producer-reference'
  const coldRecord = readJson(coldRecordFile, 256 * 1024)
  assert.equal(coldRecord.schema, 'quod-product-native-role-v1')
  assert.equal(coldRecord.role, 'record'); assert.equal(coldRecord.passed, true)
  assert.equal(coldRecord.identity.job, 'product-cloud-transport-record')
  assert.deepEqual(coldRecord.pins, result.pins)
  for (const name of ['run', 'attempt', 'sha', 'repository']) assert.equal(coldRecord.identity[name], result.identity[name])
  assert.deepEqual(coldRecord.installation, readJson(path.join(path.dirname(coldRecordFile), 'installation.json'), 256 * 1024))
  assert.equal(coldRecord.installation.passed, true)
  assert.equal(coldRecord.installation.cache.hit, '')
  assert.equal(coldRecord.installation.actualNpmCiSkipped, false)
  assert.deepEqual(coldRecord.configuration, {mode: 'check', record: true, managed: 'off', lineage: 'off', cloudConfigured: true})
  assert.equal(coldRecord.runs.length, 1)
  const producer = coldRecord.runs[0]
  assert.equal(producer.exitCode, 0); assert.equal(producer.markerCount, 1)
  assert.equal(producer.disabled, false); assert.equal(producer.unsupported, false)
  assert.equal(producer.statistics.ran, 2); assert.equal(producer.statistics.replayed, 0); assert.equal(producer.statistics.audited, 0)
  assert.equal(producer.report.success, true)
  assert.deepEqual(producer.report.counters, {numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0,
    numPendingTestSuites: 0, numTotalTests: 7, numPassedTests: 6, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0})
  assert.equal(coldRecord.publicScopeEvidence.publicScopeSha256, sha(`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`))
  const recorded = coldRecord.diagnostics?.ledger
  assert.equal(recorded?.available, true, 'actual bounded producer code evidence is required')
  assert.match(recorded.codeSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(recorded.records.map(record => record.file), EXPECTED_FILES)
  for (const record of recorded.records) {
    assert.equal(record.state, 'pass'); assert.equal(record.quarantined, false)
    assert.equal(record.witnesses, 1); assert.equal(record.plainWitnesses, 0); assert.equal(record.disagreements, 0)
  }
  result.producer = {job: coldRecord.identity.job, nativeExitCode: 0, ran: 2, replayed: 0,
    reportSha256: sha(JSON.stringify(producer.report)), codeSha256: recorded.codeSha256,
    coldWitnesses: 1, independentPlainWitnesses: 0, publicScopeEvidence: coldRecord.publicScopeEvidence}

  stage = 'pinned-binary-extraction'
  const tempRoot = fs.realpathSync(process.env.RUNNER_TEMP)
  temporary = fs.mkdtempSync(path.join(tempRoot, 'product-cloud-transport-private-'))
  fs.chmodSync(temporary, 0o700)
  const binary = path.join(temporary, 'quod')
  const extract = spawnSync('python3', [path.join(workspace(), '.quod-action/test/product-readiness-extract.py'),
    path.join(workspace(), '.quod-action/dist/quod/bin-024b929.tar.gz'), binary],
  {encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024})
  assert(!extract.error && extract.signal === null && extract.status === 0)
  result.binarySha256 = sha(read(binary, 16 * 1024 * 1024))
  assert.equal(result.binarySha256, BINARY_SHA)

  let restoreStreamHashes
  const restore = (label, key) => {
    const directory = path.join(temporary, label)
    fs.mkdirSync(directory, {mode: 0o700})
    assert.equal(fs.readdirSync(directory).length, 0)
    const env = {...process.env, QUOD_SERVER: SERVER, QUOD_SERVER_KEY: key,
      QUOD_VITEST_CLOUD_FALLBACK: '0', QUOD_SHIM_ACTIVE: '1'}
    for (const name of ['QUOD_SERVER_TOKEN', 'QUOD_VITEST_JS_DIR', 'NODE_OPTIONS']) delete env[name]
    const child = spawnSync(binary, ['vitest', '--dir', directory, '--cloud', '--suite', SUITE, '--cloud-only', 'restore'],
      {cwd: fixture(), env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024})
    assert(!child.error && child.signal === null && child.status === 0, 'Cloud CLI invocation must settle')
    restoreStreamHashes = {stdoutSha256: sha(child.stdout ?? ''), stderrSha256: sha(child.stderr ?? '')}
    return {directory, text: `${child.stdout ?? ''}\n${child.stderr ?? ''}`}
  }

  stage = 'correct-key-signed-readback'
  const accepted = restore('correct-key-empty', SERVER_KEY)
  result.restoreDiagnostics = {...restoreStreamHashes,
    restoredLogPresent: accepted.text.includes('quod vitest: restored the ledger of '),
    noLedgerLogPresent: accepted.text.includes('quod vitest: Quod Cloud has no ledger for '),
    lookupFailedLogPresent: accepted.text.includes('quod vitest: Quod Cloud lookup failed ('),
    signatureWrongKeyLogPresent: accepted.text.includes('signed by another key than the server key this runner trusts'),
    markerExists: fs.existsSync(path.join(accepted.directory, '.quod-cloud-restore.json')),
    ledgerExists: fs.existsSync(path.join(accepted.directory, 'ledger.json'))}
  stage = 'readback-marker-presence-and-schema'
  const marker = readJson(path.join(accepted.directory, '.quod-cloud-restore.json'), 64 * 1024)
  stage = 'readback-marker-tag'
  assert.equal(marker.tag, `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}/${process.env.GITHUB_JOB}/${SUITE}`)
  stage = 'readback-marker-found'
  assert.equal(marker.used.found, true)
  stage = 'readback-marker-commit'
  assert.equal(marker.used.sha, process.env.GITHUB_SHA)
  stage = 'readback-marker-id'
  assert(Number.isSafeInteger(marker.used.id) && marker.used.id > 0)
  stage = 'readback-marker-ref'
  assert.equal(marker.used.git_ref, PROOF_REF)
  stage = 'readback-marker-scope'
  assert.match(marker.used.scope, /^ref-[A-Za-z0-9._-]+$/)
  assert.notEqual(marker.used.scope, 'trusted')
  // The shipped wire verifier checks the exact hash-derived own-ref scope,
  // repository, nonce, suite and file list under the pinned server key.
  stage = 'readback-ledger-read-and-schema'
  const ledgerBytes = read(path.join(accepted.directory, 'ledger.json'), 4 * 1024 * 1024)
  const ledger = JSON.parse(ledgerBytes.toString('utf8'))
  assert.equal(ledger.version, 3); assert.match(ledger.code, /^[a-f0-9]{64}$/)
  stage = 'readback-ledger-code'
  assert.equal(sha(ledger.code), recorded.codeSha256, 'signed code identity must equal the actual producer code identity')
  stage = 'readback-ledger-args'
  assert.deepEqual(ledger.args, ['run'])
  stage = 'readback-ledger-keys'
  assert(Array.isArray(ledger.keys) && ledger.keys.length > 0 && ledger.keys.length <= 2048 && ledger.keys.length === ledger.states.length)
  assert(ledger.keys.every(key => typeof key === 'string') && ledger.states.every(state => typeof state === 'string'))
  stage = 'readback-ledger-scope'
  const scope = publicScopeEvidence(ledger)
  assert.deepEqual(scope, coldRecord.publicScopeEvidence)
  stage = 'readback-native-records'
  assert.equal(Object.keys(ledger.files).length, 2)
  const files = [], tests = [], recordHashes = [], counters = []
  const relativeFile = name => path.isAbsolute(name) ? path.relative(fixture(), name).split(path.sep).join('/') : name
  for (const record of Object.values(ledger.files)) {
    stage = 'readback-native-record-name'
    const file = relativeFile(record.file)
    assert(EXPECTED_FILES.includes(file))
    stage = 'readback-native-record-state'
    assert.equal(record.state, 'pass'); assert.equal(record.quarantined, false)
    stage = 'readback-native-record-witnesses'
    assert.equal(record.w.n, 1); assert.equal(record.plain_n, 0); assert.equal(record.w.disagreements, 0)
    stage = 'readback-result-path'
    assert.match(record.result, /^results\/[A-Za-z0-9._-]+$/)
    stage = 'readback-result-read'
    const bytes = read(path.join(accepted.directory, record.result), 2 * 1024 * 1024)
    const value = JSON.parse(bytes.toString('utf8'))
    stage = 'readback-result-file'
    assert.equal(relativeFile(value.filepath), file)
    let taskCount = 0
    const walk = (task, ancestors = [], depth = 0) => {
      stage = 'readback-result-task-structure'
      assert(++taskCount <= 32 && depth <= 8)
      assert(task && typeof task.name === 'string' && task.name.length <= 1024)
      if (task.type === 'test') {
        const status = {pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'todo'}[task.result?.state ?? task.mode]
        stage = 'readback-result-state'
        assert(status)
        tests.push([file, [...ancestors, task.name].join(' '), status])
      } else {
        assert(Array.isArray(task.tasks))
        for (const child of task.tasks) walk(child, [...ancestors, task.name], depth + 1)
      }
    }
    stage = 'readback-result-tasks'
    assert(Array.isArray(value.tasks))
    for (const task of value.tasks) walk(task)
    files.push([file, 'passed'])
    counters.push({file, witnesses: record.w.n, plainWitnesses: record.plain_n})
    recordHashes.push({file, resultSha256: sha(bytes)})
  }
  stage = 'readback-full-file-roster'
  assert.deepEqual(files.map(row => row[0]).sort(), EXPECTED_FILES)
  stage = 'readback-full-test-count'
  assert.equal(tests.length, 7)
  stage = 'readback-full-duplicate-count'
  assert.equal(tests.filter(row => row[1] === 'duplicate assertion name').length, 2)
  stage = 'readback-full-file-equality'
  assert.deepEqual(sort(files), producer.report.files)
  stage = 'readback-full-result-equality'
  assert.deepEqual(sort(tests), producer.report.tests)
  result.readback = {emptyBefore: true, verifiedPinnedServerKey: true, found: true, commit: marker.used.sha,
    gitRef: marker.used.git_ref, scope: marker.used.scope, trusted: false, ledgerId: marker.used.id,
    ledgerSha256: sha(ledgerBytes), ledgerBytes: ledgerBytes.length, codeSha256: sha(ledger.code),
    resultFiles: recordHashes.sort((a, b) => a.file.localeCompare(b.file)),
    coldCounters: counters.sort((a, b) => a.file.localeCompare(b.file)), files, tests,
    equalProducerReport: true, outputSha256: sha(accepted.text), publicScopeEvidence: scope}

  stage = 'wrong-key-rejection'
  const rejected = restore('wrong-key-empty', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  assert(!fs.existsSync(path.join(rejected.directory, 'ledger.json')))
  assert(!fs.existsSync(path.join(rejected.directory, '.quod-cloud-restore.json')))
  assert(rejected.text.includes('signed by another key than the server key this runner trusts'))
  result.wrongKey = {emptyBefore: true, ledgerPresentAfter: false, restoreMarkerPresentAfter: false,
    signedAnswerRejected: true, outputSha256: sha(rejected.text)}
  result.passed = true
} catch {
  // Fixed labels, booleans and hashes only: no CLI output, ledger contents, config or credentials.
  console.error(`QUOD_CLOUD_TRANSPORT_FAILURE_STAGE:${stage}`)
  console.error(`QUOD_CLOUD_TRANSPORT_RESTORE_DIAGNOSTICS:${JSON.stringify(result.restoreDiagnostics ?? null)}`)
  result.error = {stage, message: 'Cloud transport proof did not satisfy its required checks'}
  process.exitCode = 1
} finally {
  if (temporary) {
    try {
      fs.rmSync(temporary, {recursive: true, force: true})
      assert(!fs.existsSync(temporary))
      result.privateDirectoryRemoved = true
    } catch {
      console.error('QUOD_CLOUD_TRANSPORT_FAILURE_STAGE:private-directory-cleanup')
      result.passed = false
      result.error = {stage: 'private-directory-cleanup', message: 'Private Cloud data cleanup did not complete'}
      process.exitCode = 1
    }
  }
  write(path.join(output, 'cloud-transport.json'), result)
}
