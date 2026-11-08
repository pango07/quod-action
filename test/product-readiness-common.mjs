// Remote acceptance helpers only. No ledger, configuration or credential is published.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'

export const ARGS = ['--reporter=default', '--reporter=json', '--outputFile=./product-report.json']
export const SUITE = `product-fixture ${ARGS.join(' ')}`
export const MARKER = 'QUOD_PRODUCT_CONTROLLED_OUTPUT:v1'
export const SERVER = 'https://api.quodci.com'
export const SERVER_KEY = 'd23312bfc239da7dcd29c651dff3aea71beb08f0b3a732dff040f461a259f9f8'
export const ARCHIVE_SHA = '639eaa8cea088ef8ef1fb2ed7f6b775ccf537861f6de71ea60a98d62fbfc148d'
export const BINARY_SHA = '40a063f58cf7c9ee444e5a53bb8f36a0e12b43f5eb4237264ee046c81952338f'
export const sha = body => crypto.createHash('sha256').update(body).digest('hex')
export const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export const workspace = () => fs.realpathSync(process.env.GITHUB_WORKSPACE)
export const fixture = () => path.join(workspace(), 'product-fixture')
export const base = () => path.join(process.env.RUNNER_TEMP, 'quod')
export const summaryFile = () => path.join(base(), 'reports', `product-fixture-${sha(JSON.stringify(ARGS)).slice(0, 8)}.json.summary`)
export const ledgerDirectory = () => path.join(base(), 'vitest', `product-fixture-${sha(JSON.stringify(ARGS)).slice(0, 8)}`)
export const runIdentity = () => ({run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY})
export const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'})
}

export function pins() {
  assert.equal(process.version, 'v24.18.0')
  assert.equal(process.env.GITHUB_REPOSITORY, 'pango07/quod-action', 'this acceptance is confined to Quod’s own public repository')
  const ws = workspace(), action = path.join(ws, '.quod-action')
  assert(!fs.existsSync(path.join(ws, 'package.json')), 'sparse customer checkout must omit the Action package')
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
  assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), process.env.GITHUB_SHA)
  assert.equal(git(action, 'rev-parse', 'HEAD'), process.env.GITHUB_SHA)
  assert.equal(git(ws, 'ls-files', '--error-unmatch', 'product-fixture/package-lock.json'), 'product-fixture/package-lock.json')
  const pkg = json(path.join(fixture(), 'package.json')), lock = json(path.join(fixture(), 'package-lock.json'))
  assert.deepEqual(pkg.devDependencies, {vitest: '5.0.0'})
  assert(!pkg.workspaces && !pkg.dependencies)
  assert.deepEqual(Object.keys(pkg.scripts), ['test'])
  assert.equal(pkg.scripts.test, `vitest run ${ARGS.join(' ')}`)
  assert(lock.lockfileVersion >= 2 && lock.packages[''].devDependencies.vitest === '5.0.0')
  assert(Object.values(lock.packages).every(entry => !entry.link))
  const shipped = fs.readFileSync(path.join(action, 'dist/quod/bin-024b929.tar.gz'))
  assert.equal(sha(shipped), ARCHIVE_SHA)
  const dist = {}
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else {
        assert(entry.isFile(), 'shipped dist must contain only ordinary files/directories')
        dist[path.relative(action, file).split(path.sep).join('/')] = sha(fs.readFileSync(file))
      }
    }
  }
  walk(path.join(action, 'dist'))
  for (const name of ['dist/main/index.js', 'dist/post/index.js']) assert.match(dist[name], /^[a-f0-9]{64}$/)
  const shippedSourceSha256 = Object.fromEntries(['hook.cjs', 'deps.cjs', 'npm-install-profile.cjs', 'action.yml', 'managed-source.json']
    .map(name => [name, sha(fs.readFileSync(path.join(action, name)))]))
  return {actionSha: process.env.GITHUB_SHA, archiveSha256: ARCHIVE_SHA, node: process.version,
    packageSha256: sha(fs.readFileSync(path.join(fixture(), 'package.json'))),
    lockSha256: sha(fs.readFileSync(path.join(fixture(), 'package-lock.json'))), distSha256: dist, shippedSourceSha256}
}

// bin-024b929 vitest.rs::state encodes env values as BLAKE3 UTF-8, first
// 32 hexadecimal characters. Capture its actual state from the current
// cold run, then bind the independent signed readback to that same state.
// This deliberately does not implement a second cryptographic primitive.
export function publicScopeEvidence(ledger) {
  const scope = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  assert.equal(process.env.PRODUCT_WITNESS_SCOPE, scope)
  const key = 'env:PRODUCT_WITNESS_SCOPE'
  assert(Array.isArray(ledger.keys) && Array.isArray(ledger.states) && ledger.keys.length === ledger.states.length)
  const positions = ledger.keys.flatMap((name, index) => name === key ? [index] : [])
  assert.equal(positions.length, 1)
  const index = positions[0], state = ledger.states[index]
  assert.match(state, /^[a-f0-9]{32}$/)
  const files = Object.values(ledger.files).map(record => {
    assert(Array.isArray(record.deps) && record.deps.includes(index), 'both test files must actually observe the public witness scope')
    assert(record.pinned && typeof record.pinned === 'object' && !Array.isArray(record.pinned) && !Object.hasOwn(record.pinned, String(index)),
      'the current scope state must not be replaced by a pinned narrowing override')
    return path.isAbsolute(record.file) ? path.relative(fixture(), record.file).split(path.sep).join('/') : record.file
  }).sort()
  assert.deepEqual(files, ['tests/inputs.test.js', 'tests/math.test.js'])
  return {key, encoding: 'bin-024b929-blake3-utf8-first32hex', publicScopeSha256: sha(scope), state, files}
}

const sorted = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
export function report(value) {
  assert(value && Array.isArray(value.testResults) && value.testResults.length === 2)
  const files = [], tests = []
  for (const file of value.testResults) {
    const relative = path.relative(fixture(), file.name).split(path.sep).join('/')
    assert(['tests/math.test.js', 'tests/inputs.test.js'].includes(relative))
    assert(['passed', 'failed'].includes(file.status))
    assert(Array.isArray(file.assertionResults))
    files.push([relative, file.status])
    for (const test of file.assertionResults) {
      assert(typeof test.fullName === 'string' && ['passed', 'failed', 'pending', 'skipped', 'todo'].includes(test.status))
      tests.push([relative, test.fullName, test.status])
    }
  }
  assert.equal(tests.length, 7)
  assert.equal(tests.filter(row => row[1] === 'duplicate assertion name').length, 2)
  assert.equal(typeof value.success, 'boolean')
  assert.deepEqual(sorted(tests), sorted([
    ['tests/math.test.js', 'adds integers', 'passed'],
    ['tests/math.test.js', 'duplicate assertion name', 'passed'],
    ['tests/math.test.js', 'duplicate assertion name', 'passed'],
    ['tests/math.test.js', 'retains a skipped assertion', 'skipped'],
    ['tests/inputs.test.js', 'reads the tracked input', value.success ? 'passed' : 'failed'],
    ['tests/inputs.test.js', 'reads the declared environment input', 'passed'],
    ['tests/inputs.test.js', 'retains controlled console output', 'passed'],
  ]))
  assert.deepEqual(sorted(files), sorted([['tests/math.test.js', 'passed'],
    ['tests/inputs.test.js', value.success ? 'passed' : 'failed']]))
  return {files: sorted(files), tests: sorted(tests), success: value.success,
    counters: Object.fromEntries(['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'numTotalTests',
      'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'].map(key => {
        assert(Number.isSafeInteger(value[key]) && value[key] >= 0, `missing JSON counter ${key}`)
        return [key, value[key]]
      }))}
}

export function summary() {
  const value = json(summaryFile())
  for (const key of ['ran', 'replayed', 'audited']) assert(Number.isSafeInteger(value[key]) && value[key] >= 0)
  assert(value.ran + value.replayed === 2 && value.audited <= value.ran)
  return {ran: value.ran, replayed: value.replayed, audited: value.audited, fast: value.fast === true}
}

export function configuration(cloudExpected) {
  const value = json(path.join(base(), 'config.json'))
  assert.equal(value.mode, 'check'); assert.equal(value.record, true); assert.equal(value.managed, null)
  assert.equal(sha(fs.readFileSync(value.quod)), BINARY_SHA, 'the Action must execute its exact shipped binary')
  assert.equal(process.env.QUOD_VITEST_LINEAGE, '0')
  assert(!fs.existsSync(path.join(base(), 'managed-runtime')))
  assert(!fs.existsSync(path.join(base(), 'matrix-reports')))
  assert.equal(Boolean(value.cloud), cloudExpected)
  if (cloudExpected) {
    assert.equal(value.cloud.QUOD_SERVER, SERVER); assert.equal(value.cloud.QUOD_SERVER_KEY, SERVER_KEY)
  }
  return {mode: value.mode, record: value.record, managed: 'off', lineage: 'off', cloudConfigured: Boolean(value.cloud)}
}
