'use strict'
// Audit copies only. Collection transport/ledger admission never read these.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function createPackEvidence({directory, out}) {
  const retained = {}; let failure
  function capture(event) {
    const restored = event?.operation === 'collection-restore' && event.reason === 'hit'
    const published = event?.operation === 'collection-save'
    if (!restored && !published) return
    try {
      assert(/^[a-f0-9]{64}$/.test(event.collectionSha256), 'acknowledged collection SHA required')
      if (published) assert(Number.isSafeInteger(event.cacheId) && event.cacheId > 0, 'positive save acknowledgement required')
      const serviceKey = restored ? event.matchedServiceKey : event.key
      assert(typeof serviceKey === 'string' && serviceKey.endsWith('-' + event.collectionSha256), 'acknowledged collection service key required')
      const file = path.join(directory, 'collection.json'), stat = fs.lstatSync(file)
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 32 * 1024 * 1024, 'bounded regular acknowledged collection required')
      const bytes = fs.readFileSync(file)
      assert.equal(bytes.length, stat.size); assert.equal(sha(bytes), event.collectionSha256)
      const kind = restored ? 'restored' : 'published', output = path.join(out, kind + '-collection.json')
      fs.writeFileSync(output, bytes, {flag: 'wx', mode: 0o600})
      retained[kind] = {file: output, bytes: bytes.length, sha256: event.collectionSha256, serviceKey,
        ...(published ? {cacheId: event.cacheId} : {})}
    } catch (error) {failure = error; throw error}
  }
  return {capture, metadata: () => JSON.parse(JSON.stringify(retained)),
    assertComplete() {if (failure) throw new Error('acknowledged collection audit capture failed: ' + failure.message)}}
}
module.exports = {createPackEvidence}
