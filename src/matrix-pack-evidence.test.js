'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const {createManagedCollection, encode, prefix} = require('./managed-collection')
const {createPackEvidence} = require('./matrix-pack-evidence')
const {withCacheAuth} = require('./managed-auth')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-matrix-packs-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const directory = path.join(root, 'cache'), out = path.join(root, 'audit')
  fs.mkdirSync(out)
  return {directory, out, packs: createPackEvidence({directory, out})}
}
test('one synthetic restore/save pair retains distinct verified packs before mixed publication overwrites the cache file', async t => {
  const f = fixture(t), scope = 'a'.repeat(64), first = '1'.repeat(64), second = '2'.repeat(64)
  const previous = Buffer.from('{"syntheticReceipt":1}\n'), next = Buffer.from('{"syntheticReceipt":2}\n')
  const old = encode(scope, new Map([[first, {bytes: previous, receiptSha256: sha(previous)}]])), calls = []
  const token = 'synthetic-auth-must-not-be-copied'
  const client = createManagedCollection({directory: f.directory, scope, namespace: 'fixture-', write: true,
    withCacheAuth: operation => withCacheAuth({ACTIONS_RUNTIME_TOKEN: token}, operation), onTransport: f.packs.capture,
    sdk: {async restoreCache(paths) {assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, token); calls.push('restore'); fs.writeFileSync(paths[0], old); return prefix(scope, 'fixture-') + sha(old)},
      async saveCache() {assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, token); calls.push('save'); return 7}}})
  assert.deepEqual((await client.lookupBytes({execution: {key: first}})).receiptBytes, previous)
  const source = path.join(f.out, 'fresh-receipt.json'); fs.writeFileSync(source, next)
  client.record({execution: {key: second}, file: source, receiptSha256: sha(next)})
  assert.equal((await client.publish({exitCode: 0})).saved, true)
  f.packs.assertComplete()
  const copies = f.packs.metadata()
  assert.deepEqual(calls, ['restore', 'save']); assert.notEqual(copies.restored.sha256, copies.published.sha256)
  assert.deepEqual(fs.readFileSync(copies.restored.file), old)
  assert.equal(sha(fs.readFileSync(copies.published.file)), copies.published.sha256)
  assert.equal(copies.published.cacheId, 7)
  for (const copy of Object.values(copies)) {
    assert.equal(fs.statSync(copy.file).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(copy.file).includes(token), false)
  }
  assert.equal(JSON.stringify(copies).includes(token), false)
})
test('unacknowledged events do not copy bytes; bad acknowledged bytes stickily prevent complete evidence', t => {
  const f = fixture(t)
  f.packs.capture({operation: 'collection-restore', reason: 'miss'})
  f.packs.capture({operation: 'collection-save-error'})
  assert.deepEqual(f.packs.metadata(), {})
  fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, 'collection.json'), '{}\n')
  assert.throws(() => f.packs.capture({operation: 'collection-save', cacheId: 7, collectionSha256: '0'.repeat(64), key: 'fixture-' + '0'.repeat(64)}))
  assert.throws(() => f.packs.assertComplete(), /audit capture failed/)
  assert.deepEqual(f.packs.metadata(), {})
})
