import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {ARCHIVE_SHA, BINARY_SHA, SERVER, SERVER_KEY, SUITE, fixture, json, pins, publicScopeEvidence, runIdentity, sha, workspace, write} from './product-readiness-common.mjs'

const [output, coldRecordFile] = process.argv.slice(2)
assert(output && coldRecordFile)
const result = {schema: 'quod-product-cloud-readback-v1', passed: false, identity: runIdentity(), suite: SUITE,
  archiveSha256: ARCHIVE_SHA, localLedgerFallback: false, actionExecutedInThisJob: false}
const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'product-cloud-private-'))
try {
  result.pins = pins()
  const coldRecord = json(coldRecordFile)
  assert.equal(coldRecord.schema, 'quod-product-native-role-v1'); assert.equal(coldRecord.role, 'record'); assert.equal(coldRecord.passed, true)
  assert.deepEqual(coldRecord.pins, result.pins)
  for (const name of ['run', 'attempt', 'sha', 'repository']) assert.equal(coldRecord.identity[name], result.identity[name])
  assert.equal(coldRecord.installation.cache.hit, ''); assert.equal(coldRecord.installation.actualNpmCiSkipped, false)
  assert.equal(coldRecord.runs[0].statistics.ran, 2); assert.equal(coldRecord.runs[0].statistics.replayed, 0)
  assert.equal(coldRecord.publicScopeEvidence.publicScopeSha256, sha(`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`))
  assert(!process.env.QUOD_SERVER_TOKEN, 'only the actual job OIDC identity is accepted')
  for (const name of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) assert(process.env[name])
  assert(!fs.existsSync(path.join(process.env.RUNNER_TEMP, 'quod/config.json')))
  const binary = path.join(temporary, 'quod')
  const extract = spawnSync('python3', [path.join(workspace(), '.quod-action/test/product-readiness-extract.py'),
    path.join(workspace(), '.quod-action/dist/quod/bin-024b929.tar.gz'), binary],
  {encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024})
  assert(!extract.error && extract.status === 0, 'the shipped binary archive must verify and extract exactly')
  result.binarySha256 = sha(fs.readFileSync(binary))
  assert.equal(result.binarySha256, BINARY_SHA)
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
    return {directory, text: `${child.stdout ?? ''}\n${child.stderr ?? ''}`}
  }
  const accepted = restore('correct-key-empty', SERVER_KEY)
  const marker = json(path.join(accepted.directory, '.quod-cloud-restore.json'))
  assert.equal(marker.tag, `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}/${process.env.GITHUB_JOB}/${SUITE}`)
  assert.equal(marker.used.found, true)
  assert.equal(marker.used.sha, process.env.GITHUB_SHA, 'readback must observe publication by this shipped commit')
  assert(Number.isSafeInteger(marker.used.id) && marker.used.id > 0)
  const ledgerBytes = fs.readFileSync(path.join(accepted.directory, 'ledger.json'))
  assert(ledgerBytes.length > 0 && ledgerBytes.length < 4 * 1024 * 1024)
  const ledger = JSON.parse(ledgerBytes)
  const scope = publicScopeEvidence(ledger)
  assert.deepEqual(scope, coldRecord.publicScopeEvidence, 'the signed ledger must contain this acceptance run’s actual cold-record scope state')
  assert.equal(ledger.version, 3); assert.match(ledger.code, /^[a-f0-9]{64}$/)
  assert.deepEqual(ledger.args, ['run']) // bin-024 excludes only reporter/output formatting arguments.
  assert(Array.isArray(ledger.keys) && ledger.keys.length > 0 && ledger.keys.length === ledger.states.length)
  assert(ledger.keys.every(key => typeof key === 'string') && ledger.states.every(state => typeof state === 'string'))
  assert.equal(Object.keys(ledger.files).length, 2)
  const files = [], tests = [], recordHashes = []
  const relativeFile = name => path.isAbsolute(name) ? path.relative(fixture(), name).split(path.sep).join('/') : name
  for (const record of Object.values(ledger.files)) {
    const file = relativeFile(record.file)
    assert(['tests/math.test.js', 'tests/inputs.test.js'].includes(file))
    assert.equal(record.state, 'pass'); assert.equal(record.quarantined, false)
    assert(record.w.n >= 2 && record.plain_n >= 1, 'Cloud must retain the independent second witness')
    assert.match(record.result, /^results\/[A-Za-z0-9._-]+$/)
    const bytes = fs.readFileSync(path.join(accepted.directory, record.result))
    assert(bytes.length > 0 && bytes.length < 2 * 1024 * 1024)
    const value = JSON.parse(bytes)
    assert.equal(relativeFile(value.filepath), file)
    const walk = (task, ancestors = []) => {
      assert(task && typeof task.name === 'string')
      if (task.type === 'test') {
        const state = task.result?.state ?? task.mode
        const status = {pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'todo'}[state]
        assert(status, 'all restored test states must be understood')
        tests.push([file, [...ancestors, task.name].join(' '), status])
      } else {
        assert(Array.isArray(task.tasks))
        for (const child of task.tasks) walk(child, [...ancestors, task.name])
      }
    }
    assert(Array.isArray(value.tasks))
    for (const task of value.tasks) walk(task)
    files.push([file, 'passed'])
    recordHashes.push({file, resultSha256: sha(bytes)})
  }
  const sort = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  assert.equal(tests.length, 7)
  assert.equal(tests.filter(row => row[1] === 'duplicate assertion name').length, 2)
  result.readback = {emptyBefore: true, verifiedPinnedServerKey: true, found: true, commit: marker.used.sha,
    ledgerSha256: sha(ledgerBytes), ledgerBytes: ledgerBytes.length, resultFiles: recordHashes,
    files: sort(files), tests: sort(tests), outputSha256: sha(accepted.text), publicScopeEvidence: scope}
  const rejected = restore('wrong-key-empty', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  assert(!fs.existsSync(path.join(rejected.directory, 'ledger.json')))
  assert(!fs.existsSync(path.join(rejected.directory, '.quod-cloud-restore.json')))
  assert(rejected.text.includes('signed by another key than the server key this runner trusts'),
    'the wrong valid server key must be rejected by the signed-answer check')
  result.wrongKey = {emptyBefore: true, ledgerPresentAfter: false, restoreMarkerPresentAfter: false,
    signedAnswerRejected: true, outputSha256: sha(rejected.text)}
  result.passed = true
} catch (error) {
  result.error = {name: error.name, message: String(error.message).slice(0, 1000)}
  process.exitCode = 1
} finally {
  fs.rmSync(temporary, {recursive: true, force: true})
  write(path.join(output, 'cloud-readback.json'), result)
}
