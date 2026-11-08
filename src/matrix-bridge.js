'use strict'
// Explicit finite-profile research bridge. Native JSON for the ordinary subset
// is never presented as the logical full suite. v0 keeps its existing bridge.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const {pathToFileURL} = require('node:url')
const {spawnSync} = require('node:child_process')
const cache = require('@actions/cache')
const {loadCacheAuth, withCacheAuth} = require('./managed-auth')
const {createManagedCollection} = require('./managed-collection')
const {createPackEvidence} = require('./matrix-pack-evidence')
// Keep native ESM imports intact through ncc, as in the existing v0 bridge.
const importRuntime = new Function('specifier', 'return import(specifier)')
const AUTH_KEYS = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_SERVICE_V2', 'ACTIONS_RUNTIME_URL']
const MODES = ['matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']
const PROPERTY47_PROFILE = 'reviewed-original-property47-single-instance-v1-research'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
let dispatchStarted = false, privateSession

async function main() {
  const [configFile, vitestEntry, ...args] = process.argv.slice(2)
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')), managed = cfg.managed
  assert(MODES.includes(managed?.mode), 'explicit matrix research mode required')
  const control = ['matrix-control', 'matrix-property47-control'].includes(managed.mode)
  const candidateProfile = ['matrix-property47', 'matrix-property47-control'].includes(managed.mode) ? PROPERTY47_PROFILE : null
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(cfg.root), 'matrix profile requires repository-root invocation')
  const entry = fs.realpathSync(vitestEntry), project = fs.realpathSync(cfg.root)
  assert.equal(entry, path.join(project, 'node_modules/vitest/vitest.mjs'), 'reviewed project Vitest entry required')
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'))).version, '5.0.0', 'reviewed Vitest5 required')
  const base = path.dirname(configFile)
  const session = path.resolve(managed.cacheAuth)
  assert.equal(session, path.join(base, 'managed-cache-auth.json'), 'private job session path differs')
  privateSession = session
  const st = fs.lstatSync(privateSession)
  assert(st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size < 65536 &&
    (st.mode & 0o777) === 0o600, 'private regular0600 cache session required')
  const auth = loadCacheAuth(privateSession)
  assert(typeof auth.ACTIONS_RUNTIME_TOKEN === 'string' && auth.ACTIONS_RUNTIME_TOKEN, 'cache session unavailable')
  // Earlier native install/build steps are trusted in this finite profile.
  // Same-UID test children must not be able to read this setup-step credential.
  fs.unlinkSync(privateSession)
  for (const key of AUTH_KEYS) delete process.env[key]
  assert(!fs.existsSync(privateSession), 'cache session must be consumed before Vitest dispatch')
  assert(args.length === 1 && args[0] === 'run', 'matrix profile accepts only exact default vitest run')
  // Match the existing public Vitest/preparation bootstrap before the first
  // immutable compiler-tool observation. Preserve an explicit NODE_ENV.
  process.env.TEST = 'true'; process.env.VITEST = 'true'; process.env.NODE_ENV ??= 'test'

  // Import only the builtin-only runtime bootstrap before its private tool
  // epoch. Preparation/dispatcher imports can preload the compiler.
  const bootstrap = await importRuntime(pathToFileURL(path.join(managed.runtime, 'resolved-compile-certificate.mjs')).href)
  assert.equal(typeof bootstrap.createCertifiedManagedCompiler, 'function')
  await bootstrap.createCertifiedManagedCompiler({project})
  const {dispatchManagedInputMatrix} = await importRuntime(pathToFileURL(path.join(managed.runtime, 'matrix-input-dispatcher.mjs')).href)
  assert.equal(typeof dispatchManagedInputMatrix, 'function')
  const out = fs.mkdtempSync(path.join(base, 'matrix-run-')), transport = []
  const directory = path.join(base, 'managed-matrix-collection')
  const packs = createPackEvidence({directory, out})
  const transportFile = path.join(out, 'cache-transport.json')
  const retainTransport = event => {
    if (event) {packs.capture(event); transport.push(event)}
    fs.writeFileSync(transportFile, JSON.stringify({schema: 'quod-managed-matrix-action-cache-v1', events: transport}, null, 2) + '\n')
  }
  const scopeInput = {schema: 'quod-managed-matrix-action-input-scope-v1', source: managed.source,
    runtimeArchiveSha256: managed.archiveSha256, bridgeSha256: sha(fs.readFileSync(__filename)),
    nodeVersion: process.version, cacheSdkVersion: require('@actions/cache/package.json').version,
    ...(candidateProfile ? {candidateProfile} : {})}
  const scope = sha(bootstrap.canonicalManagedJSON(scopeInput))
  const collection = createManagedCollection({sdk: cache, directory, scope, namespace: managed.namespace,
    control, write: managed.write === true,
    withCacheAuth: operation => withCacheAuth(auth, operation), onTransport: retainTransport})
  dispatchStarted = true
  const result = await dispatchManagedInputMatrix({project, out, epoch: managed.epoch, seed: managed.seed,
    env: managed.env, control, ...(candidateProfile ? {candidateProfile} : {}),
    lookup: ({candidateKey}) => collection.lookupBytes({execution: {key: candidateKey}}),
    ...(managed.write === true && !control ? {
      record: ({candidateKey, file, envelopeSha256}) => collection.record({execution: {key: candidateKey}, file,
        receiptSha256: envelopeSha256}),
    } : {}), publish: collection.publish})
  retainTransport()
  packs.assertComplete()
  assert(Number.isInteger(result.exitCode) && [0, 1].includes(result.exitCode), 'complete matrix exit status required')
  let logicalReport = null
  if (result.logicalReport) {
    const report = result.logicalReport, expected = path.join(out, 'logical-results.json')
    assert.equal(report.file, expected, 'logical report outside this invocation')
    const bytes = fs.readFileSync(expected), data = JSON.parse(bytes)
    assert.equal(sha(bytes), report.sha256); assert.equal(bytes.length, report.bytes)
    assert.equal(data.schema, 'quod-managed-matrix-input-logical-results-v1')
    assert.equal(data.exitCode, result.exitCode); assert.equal(data.sha256, result.logicalSha256)
    assert.equal(data.files.length, result.selectedInstances); assert.equal(data.rows.length, result.logicalStates)
    assert.equal(report.instances, data.files.length); assert.equal(report.states, data.rows.length)
    assert.equal(report.schema, data.schema)
    const reports = path.join(base, 'matrix-reports')
    fs.mkdirSync(reports, {recursive: true})
    const name = path.basename(out)
    const retained = path.join(reports, name + '.logical.json')
    fs.writeFileSync(retained, bytes, {flag: 'wx'})
    logicalReport = {...report, file: retained}
  } else assert.notEqual(result.exitCode, 0, 'successful command omitted complete logical report')
  const summary = {schema: 'quod-managed-matrix-action-result-v1', mode: managed.mode, exitCode: result.exitCode,
    fullJobHit: result.fullJobHit, reportFidelity: result.reportFidelity,
    selectedScope: result.selectedScope, selectedInstances: result.selectedInstances,
    candidateInstances: result.candidateInstances, replayedInstances: result.replayedInstances,
    skippedCompilations: result.skippedCompilations, managedExecutions: result.managedExecutions,
    nativeSpecsExecuted: result.nativeSpecsExecuted, ordinaryInstances: result.ordinaryInstances,
    recordedReceipts: result.recordedReceipts, stickyManagedFailure: result.stickyManagedFailure,
    logicalSha256: result.logicalSha256, logicalStates: result.logicalStates, logicalReport,
    seconds: result.seconds, publication: result.publication, evidenceDirectory: out,
    cacheTransport: {file: transportFile, scope, scopeInput, namespace: managed.namespace},
    retainedCollections: packs.metadata(),
    authLifecycle: {sessionConsumedBeforeVitestDispatch: !fs.existsSync(privateSession),
      authAbsentOutsideSdk: AUTH_KEYS.every(key => !Object.hasOwn(process.env, key)),
      earlierInstallBuildScope: 'reviewed finite trusted workflow; no general same-UID isolation claim'}}
  assert(summary.authLifecycle.sessionConsumedBeforeVitestDispatch && summary.authLifecycle.authAbsentOutsideSdk)
  if (logicalReport) fs.writeFileSync(path.join(path.dirname(logicalReport.file), path.basename(out) + '.summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log('QUOD_MANAGED_MATRIX_INPUT_RESULT ' + JSON.stringify(summary))
  console.log(`Quod matrix logical suite: ${result.selectedInstances || 0} instances, ${result.logicalStates || 0} states; ` +
    `${result.replayedInstances || 0} replayed, ${result.nativeSpecsExecuted || 0} native; exit ${result.exitCode}.`)
  return result.exitCode
}

main().then(code => {process.exitCode = code}).catch(error => {
  if (dispatchStarted) {
    console.error(`quod matrix: dispatcher stopped (${error.message}); failing the command`)
    process.exitCode = 1
    return
  }
  console.error(`quod matrix: profile unavailable (${error.message}); running original Vitest`)
  for (const key of AUTH_KEYS) delete process.env[key]
  if (privateSession) fs.rmSync(privateSession, {force: true})
  const [, vitestEntry, ...args] = process.argv.slice(2)
  const ordinary = spawnSync(process.execPath, [vitestEntry, ...args], {stdio: 'inherit',
    env: {...process.env, QUOD_SHIM_ACTIVE: '1'}})
  process.exitCode = ordinary.status ?? 1
}).finally(() => {
  for (const key of AUTH_KEYS) delete process.env[key]
  if (privateSession) fs.rmSync(privateSession, {force: true})
})
