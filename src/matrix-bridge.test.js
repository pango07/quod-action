'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {spawnSync} = require('node:child_process')

// These are bridge ordering/failure fixtures, never cache or compiler authority.
function fixture(t, {kind = 'pass', bundled = false, consumed = false, nodeEnv,
  mode = 'matrix-control', write = false, verifyControlSdk = false} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-matrix-bridge-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project'), runtime = path.join(base, 'runtime')
  fs.mkdirSync(path.join(root, 'node_modules/vitest'), {recursive: true}); fs.mkdirSync(runtime)
  const session = path.join(base, 'managed-cache-auth.json'), ordinary = path.join(base, 'ordinary-executed')
  const control = ['matrix-control', 'matrix-property47-control'].includes(mode)
  const property = ['matrix-property47', 'matrix-property47-control'].includes(mode)
  const profile = 'reviewed-original-property47-single-instance-v1-research'
  const entry = path.join(root, 'node_modules/vitest/vitest.mjs'), config = path.join(base, 'config.json')
  fs.writeFileSync(entry, `import fs from 'node:fs'; import assert from 'node:assert/strict';
    assert(!fs.existsSync(${JSON.stringify(session)})); assert(!process.env.ACTIONS_RUNTIME_TOKEN);
    fs.writeFileSync(${JSON.stringify(ordinary)}, 'ordinary');\n`)
  fs.writeFileSync(path.join(root, 'node_modules/vitest/package.json'), '{"version":"5.0.0"}')
  if (!consumed) fs.writeFileSync(session, '{"ACTIONS_RUNTIME_TOKEN":"fixture-not-actual-service-auth"}', {mode: 0o600})
  if (kind !== 'missing') fs.writeFileSync(path.join(runtime, 'resolved-compile-certificate.mjs'), `
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    export const canonicalManagedJSON = JSON.stringify;
    export async function createCertifiedManagedCompiler(){
      assert(!fs.existsSync(${JSON.stringify(session)})); assert(!process.env.ACTIONS_RUNTIME_TOKEN);
      assert.equal(process.env.TEST, 'true'); assert.equal(process.env.VITEST, 'true');
      assert.equal(process.env.NODE_ENV, ${JSON.stringify(nodeEnv ?? 'test')});
      globalThis.quodFixtureInitialNodeEnv = process.env.NODE_ENV;
      globalThis.quodFixtureFactoryInitialized = true;
    }\n`)
  fs.writeFileSync(path.join(runtime, 'matrix-input-dispatcher.mjs'), `
    import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
    assert.equal(globalThis.quodFixtureFactoryInitialized, true, 'dispatcher imported before certified bootstrap');
    assert.equal(process.env.NODE_ENV, globalThis.quodFixtureInitialNodeEnv, 'bootstrap environment changed before dispatcher');
    export async function dispatchManagedInputMatrix(options){
      const {out} = options;
      assert(!fs.existsSync(${JSON.stringify(session)})); assert(!process.env.ACTIONS_RUNTIME_TOKEN);
      assert.equal(options.control, ${control});
      assert.equal(Object.hasOwn(options, 'candidateProfile'), ${property});
      assert.equal(options.candidateProfile, ${property ? JSON.stringify(profile) : 'undefined'});
      assert.equal(Object.hasOwn(options, 'suiteFiles'), false, 'bridge must retain complete default selection');
      assert.equal(typeof options.record, ${JSON.stringify(write && !control ? 'function' : 'undefined')});
      let publication;
      ${verifyControlSdk ? `assert.equal(await options.lookup({candidateKey: 'd'.repeat(64)}), null);
        publication = await options.publish({exitCode: 0});
        assert.deepEqual(publication, {saved: false, reason: 'control'});
        assert(!process.env.ACTIONS_RUNTIME_TOKEN);` : ''}
      ${kind === 'late' ? 'throw new Error("fixture late sticky failure");' : ''}
      const sha256 = 'c'.repeat(64), schema = 'quod-managed-matrix-input-logical-results-v1';
      const data = {schema, files:[{project:'fixture',file:'one.test.ts',pool:'forks',name:'one.test.ts',state:'pass'}],
        rows:[{project:'fixture',file:'one.test.ts',pool:'forks',name:'original assertion',state:'pass'}], sha256, exitCode:0};
      const file = path.join(out, 'logical-results.json'), bytes = Buffer.from(JSON.stringify(data)+'\\n'); fs.writeFileSync(file, bytes);
      return {exitCode:0, fullJobHit:false, selectedInstances:1, candidateInstances:1, replayedInstances:1,
        skippedCompilations:1, managedExecutions:0,nativeSpecsExecuted:0,ordinaryInstances:0,recordedReceipts:0,
        logicalSha256:sha256, logicalStates:1, seconds:0, publication,
        logicalReport:{file, schema, sha256:${kind === 'bad-report' ? "'0'.repeat(64)" : "crypto.createHash('sha256').update(bytes).digest('hex')"},bytes:bytes.length,instances:1,states:1}};
    }\n`)
  fs.writeFileSync(config, JSON.stringify({root, managed: {mode, runtime, cacheAuth: session,
    epoch: 1700000000000, seed: 42, env: {NODE_ENV: 'test'}, write, namespace: 'fixture-',
    source: {repository: 'pango07/quod', commit: 'a'.repeat(40)}, archiveSha256: 'b'.repeat(64)}}))
  const bridge = path.resolve(__dirname, bundled ? '../dist/matrix-bridge/index.js' : 'matrix-bridge.js')
  assert(fs.existsSync(bridge), 'build the actual bridge on the runner first')
  const environment = {...process.env, QUOD_SHIM_ACTIVE: '1', ACTIONS_RUNTIME_TOKEN: 'inherited-fixture-auth'}
  if (nodeEnv === undefined) delete environment.NODE_ENV
  else environment.NODE_ENV = nodeEnv
  const child = spawnSync(process.execPath, [bridge, config, entry, 'run'], {cwd: root,
    env: environment,
    encoding: 'utf8', timeout: 15000})
  assert(!child.error, child.error?.message)
  const line = child.stdout.split('\n').find(line => line.startsWith('QUOD_MANAGED_MATRIX_INPUT_RESULT '))
  return {base, child, ordinary, session, result: line ? JSON.parse(line.slice('QUOD_MANAGED_MATRIX_INPUT_RESULT '.length)) : null}
}
test('matrix bridge bootstraps before imports, consumes auth before children and emits a separate full logical report', t => {
  const f = fixture(t)
  assert.equal(f.child.status, 0, f.child.stderr); assert.equal(fs.existsSync(f.ordinary), false)
  assert.equal(fs.existsSync(f.session), false)
  assert.equal(f.result.logicalReport.instances, 1); assert.equal(f.result.logicalReport.states, 1)
  assert.equal(f.result.authLifecycle.authAbsentOutsideSdk, true)
  assert.equal(f.result.cacheTransport.namespace, 'fixture-')
  assert.equal(f.result.fullJobHit, false)
  assert.match(f.result.logicalReport.file, /matrix-reports/)
})
test('late failure and changed report bytes fail closed without ordinary retry', t => {
  for (const kind of ['late', 'bad-report']) {
    const f = fixture(t, {kind})
    assert.equal(f.child.status, 1); assert.equal(fs.existsSync(f.ordinary), false)
    assert.equal(fs.existsSync(f.session), false); assert.match(f.child.stderr, /dispatcher stopped/)
  }
})
test('public CLI bootstrap precedes the epoch and preserves explicit NODE_ENV', t => {
  const f = fixture(t, {nodeEnv: 'production'})
  assert.equal(f.child.status, 0, f.child.stderr)
  assert.equal(f.result.exitCode, 0); assert.equal(fs.existsSync(f.ordinary), false)
})
test('missing bootstrap or a consumed session falls back to original ordinary execution without auth', t => {
  for (const options of [{kind: 'missing'}, {consumed: true}]) {
    const f = fixture(t, options)
    assert.equal(f.child.status, 0, f.child.stderr); assert.equal(fs.readFileSync(f.ordinary, 'utf8'), 'ordinary')
    assert.equal(fs.existsSync(f.session), false); assert.equal(f.result, null)
  }
})
test('actual ncc matrix bridge keeps native ESM bootstrap ordering and sticky late failure', t => {
  const f = fixture(t, {kind: 'late', bundled: true})
  assert.equal(f.child.status, 1); assert.equal(fs.existsSync(f.ordinary), false)
  assert.match(f.child.stderr, /fixture late sticky failure/)
})

test('property modes bind the closed profile in scope and dispatch while defaults retain their scope shape', t => {
  const profile = 'reviewed-original-property47-single-instance-v1-research', values = new Map()
  for (const mode of ['matrix-research', 'matrix-control', 'matrix-property47', 'matrix-property47-control']) {
    const control = mode.endsWith('-control')
    const f = fixture(t, {mode, write: true, verifyControlSdk: control})
    assert.equal(f.child.status, 0, f.child.stderr); assert.equal(fs.existsSync(f.ordinary), false)
    assert.equal(fs.existsSync(f.session), false); assert.equal(f.result.mode, mode)
    const input = f.result.cacheTransport.scopeInput
    assert.deepEqual(Object.keys(input), ['schema', 'source', 'runtimeArchiveSha256', 'bridgeSha256', 'nodeVersion', 'cacheSdkVersion',
      ...(mode.startsWith('matrix-property47') ? ['candidateProfile'] : [])])
    assert.equal(input.candidateProfile, mode.startsWith('matrix-property47') ? profile : undefined)
    if (control) {
      assert.deepEqual(f.result.publication, {saved: false, reason: 'control'})
      assert.deepEqual(JSON.parse(fs.readFileSync(f.result.cacheTransport.file, 'utf8')).events, [])
      assert.equal(fs.existsSync(path.join(f.base, 'managed-matrix-collection')), false)
    }
    values.set(mode, f.result.cacheTransport.scope)
  }
  assert.equal(values.get('matrix-research'), values.get('matrix-control'))
  assert.equal(values.get('matrix-property47'), values.get('matrix-property47-control'))
  assert.notEqual(values.get('matrix-research'), values.get('matrix-property47'))
})

test('property bridge late failures and consumed sessions preserve sticky exit and credential cleanup', t => {
  for (const mode of ['matrix-property47', 'matrix-property47-control']) {
    const late = fixture(t, {mode, kind: 'late', write: true})
    assert.equal(late.child.status, 1); assert.equal(fs.existsSync(late.ordinary), false)
    assert.equal(fs.existsSync(late.session), false); assert.match(late.child.stderr, /dispatcher stopped/)
    const consumed = fixture(t, {mode, consumed: true})
    assert.equal(consumed.child.status, 0, consumed.child.stderr)
    assert.equal(fs.readFileSync(consumed.ordinary, 'utf8'), 'ordinary'); assert.equal(consumed.result, null)
  }
})
