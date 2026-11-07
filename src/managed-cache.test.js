'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {receiptPrefix, trustedDigest} = require('./managed-cache')
test('only an exact execution, namespace and whole digest returned by the cache service can authorize a receipt', () => {
  const key = 'a'.repeat(64), hash = 'b'.repeat(64), namespace = 'cold-chain-'
  const full = receiptPrefix(key, namespace) + hash
  assert.equal(trustedDigest(full, key, namespace), hash)
  for (const value of [undefined, null, {}, hash, full + '-tail', full + '\n', full.slice(0, -1),
    receiptPrefix('c'.repeat(64), namespace) + hash, receiptPrefix(key, 'other-') + hash,
    receiptPrefix(key) + hash, receiptPrefix(key, namespace) + 'lookup']) {
    assert.equal(trustedDigest(value, key, namespace), null)
  }
  assert.throws(() => receiptPrefix(key, '../scope-'))
  assert.throws(() => receiptPrefix('not-an-execution'))
})
