'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {spawnSync} = require('node:child_process')

// These are bridge ordering/failure fixtures, never cache or compiler authority.
function fixture(t, {kind = 'pass', bundled = false, consumed = false, nodeEnv} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-matrix-bridge-')))
  t.after(() => fs.rmSync(base, {recursive: true, force: true}))
  const root = path.join(base, 'project'), runtime = path.join(base, 'runtime')
  fs.mkdirSync(path.join(root, 'node_modules/vitest'), {recursive: true}); fs.mkdirSync(runtime)
  const session = path.join(base, 'managed-cache-auth.json'), ordinary = path.join(base, 'ordinary-executed')
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
    export async function dispatchManagedInputMatrix({out}){
      assert(!fs.existsSync(${JSON.stringify(session)})); assert(!process.env.ACTIONS_RUNTIME_TOKEN);
      ${kind === 'late' ? 'throw new Error("fixture late sticky failure");' : ''}
      const sha256 = 'c'.repeat(64), schema = 'quod-managed-matrix-input-logical-results-v1';
      const data = {schema, files:[{project:'fixture',file:'one.test.ts',pool:'forks',name:'one.test.ts',state:'pass'}],
        rows:[{project:'fixture',file:'one.test.ts',pool:'forks',name:'original assertion',state:'pass'}], sha256, exitCode:0};
      const file = path.join(out, 'logical-results.json'), bytes = Buffer.from(JSON.stringify(data)+'\\n'); fs.writeFileSync(file, bytes);
      return {exitCode:0, fullJobHit:false, selectedInstances:1, candidateInstances:1, replayedInstances:1,
        skippedCompilations:1, managedExecutions:0,nativeSpecsExecuted:0,ordinaryInstances:0,recordedReceipts:0,
        logicalSha256:sha256, logicalStates:1, seconds:0,
        logicalReport:{file, schema, sha256:${kind === 'bad-report' ? "'0'.repeat(64)" : "crypto.createHash('sha256').update(bytes).digest('hex')"},bytes:bytes.length,instances:1,states:1}};
    }\n`)
  fs.writeFileSync(config, JSON.stringify({root, managed: {mode: 'matrix-control', runtime, cacheAuth: session,
    epoch: 1700000000000, seed: 42, env: {NODE_ENV: 'test'}, write: false, namespace: 'fixture-',
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
