'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {captureCacheAuth, loadCacheAuth, withCacheAuth} = require('./managed-auth')
test('cache session is private, limited to service fields and absent after the SDK operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-cache-auth-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const file = path.join(root, 'auth.json')
  captureCacheAuth(file, {ACTIONS_RUNTIME_TOKEN: 'fixture-session', ACTIONS_RESULTS_URL: 'https://fixture.invalid', UNRELATED: 'excluded'})
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const auth = loadCacheAuth(file)
  assert.deepEqual(auth, {ACTIONS_RUNTIME_TOKEN: 'fixture-session', ACTIONS_RESULTS_URL: 'https://fixture.invalid'})
  const before = process.env.ACTIONS_RUNTIME_TOKEN
  await assert.rejects(withCacheAuth(auth, async () => {
    assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, 'fixture-session')
    await Promise.resolve()
    throw new Error('fixture SDK failure')
  }), /fixture SDK failure/)
  assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, before)
  assert.throws(() => captureCacheAuth(file, {}))
})
