'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const {withCacheAuth} = require('./managed-auth')
const C = require('./managed-collection')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const scope = 'a'.repeat(64), namespace = 'matrix-fixture-'
const key = number => number.toString(16).padStart(64, '0')
const receipt = number => Buffer.from(JSON.stringify({fixtureOnly: true, observation: number}) + '\n')
const packed = entries => C.encode(scope, new Map(entries.map(([id, bytes]) => [id, {bytes, receiptSha256: hash(bytes)}])))

function fixture(t, {backend = new Map(), restore, save, control = false, write = true} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-collection-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const directory = path.join(root, 'collection'), calls = [], events = []
  const before = process.env.ACTIONS_RUNTIME_TOKEN, token = 'fixture-private-cache-session'
  const sdk = {
    async restoreCache(paths, lookup, prefixes) {
      assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, token)
      assert.equal(paths.length, 1); assert.equal(path.basename(paths[0]), 'collection.json')
      calls.push({operation: 'restore', paths, lookup, prefixes})
      if (restore) return restore(paths, lookup, prefixes)
      const matched = [...backend.keys()].reverse().find(name => name.startsWith(prefixes[0]))
      if (matched) fs.writeFileSync(paths[0], backend.get(matched))
      return matched
    },
    async saveCache(paths, serviceKey) {
      assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, token)
      calls.push({operation: 'save', paths, serviceKey})
      if (save) return save(paths, serviceKey)
      backend.set(serviceKey, fs.readFileSync(paths[0])); return 123
    },
  }
  const client = C.createManagedCollection({sdk, directory, scope, namespace, control, write,
    withCacheAuth: operation => withCacheAuth({ACTIONS_RUNTIME_TOKEN: token}, operation), onTransport: event => events.push(event)})
  const record = (id, bytes) => {
    const file = path.join(root, `receipt-${id}.json`)
    fs.writeFileSync(file, bytes)
    return client.record({execution: {key: id}, file, receiptSha256: hash(bytes)})
  }
  const authRestored = () => assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, before)
  return {root, directory, calls, events, backend, client, record, authRestored}
}

test('117 executions share one authenticated restore and one awaited whole-command save', async t => {
  const f = fixture(t), ids = Array.from({length: 117}, (_, i) => key(i + 1))
  assert.deepEqual(await Promise.all(ids.map(id => f.client.lookup({execution: {key: id}}))), ids.map(() => null))
  f.authRestored(); assert.equal(f.calls.length, 1)
  for (const [i, id] of ids.entries()) assert.equal(f.record(id, receipt(i)).queued, true)
  assert.equal(f.calls.length, 1, 'records never perform per-entry saves')
  const pending = f.client.publish({exitCode: 0})
  assert.equal(f.client.publish({exitCode: 0}), pending)
  const result = await pending
  f.authRestored(); assert.equal(result.saved, true); assert.equal(result.entries, 117)
  assert.deepEqual(f.calls.map(call => call.operation), ['restore', 'save'])
  const bytes = [...f.backend.values()][0]
  assert.equal(C.decode(bytes, scope).size, 117)
  assert.equal(C.serviceDigest(f.calls[1].serviceKey, scope, namespace), hash(bytes))
  assert.ok(f.events.every(event => Object.values(event).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))))
  assert.ok(!bytes.includes('fixture-private-cache-session'))
})

test('changed execution identities reuse unchanged entries and publish one bounded current collection', async t => {
  const old = Array.from({length: 117}, (_, i) => [key(i + 1), receipt(i)])
  const bytes = packed(old), backend = new Map([[C.prefix(scope, namespace) + hash(bytes), bytes]])
  const f = fixture(t, {backend}), current = old.slice(0, 116).map(([id]) => id).concat(key(1000))
  const hits = await Promise.all(current.map(id => f.client.lookupBytes({execution: {key: id}})))
  assert.equal(hits.filter(Boolean).length, 116); assert.equal(hits[116], null)
  for (let i = 0; i < 116; i++) {
    assert.equal(hits[i].trustedReceiptSha256, hash(old[i][1]))
    assert.deepEqual(hits[i].receiptBytes, old[i][1])
  }
  hits[0].receiptBytes.fill(0)
  assert.deepEqual((await f.client.lookupBytes({execution: {key: current[0]}})).receiptBytes, old[0][1], 'returned bytes cannot mutate authenticated loaded entries')
  f.record(key(1000), receipt(1000))
  assert.equal((await f.client.publish({exitCode: 0})).saved, true)
  assert.deepEqual(f.calls.map(call => call.operation), ['restore', 'save'])
  const latest = C.decode([...backend.values()].at(-1), scope)
  assert.equal(latest.size, 117); assert.equal(latest.has(key(117)), false); assert.equal(latest.has(key(1000)), true)
  const replay = fixture(t, {backend})
  assert.equal((await Promise.all(current.map(id => replay.client.lookup({execution: {key: id}})))).filter(Boolean).length, 117)
  assert.deepEqual(await replay.client.publish({exitCode: 0}), {saved: false, reason: 'no-new-receipts'})
  assert.deepEqual(replay.calls.map(call => call.operation), ['restore'])
  f.authRestored(); replay.authRestored()
})

test('service-returned whole-byte authority is required even when a valid local pack exists', async t => {
  const bytes = packed([[key(1), receipt(1)]])
  for (const matched of [undefined, C.prefix(scope, 'other-') + hash(bytes), C.prefix('b'.repeat(64), namespace) + hash(bytes),
    C.prefix(scope, namespace) + 'lookup', C.prefix(scope, namespace) + hash(bytes) + '-tail']) {
    const f = fixture(t, {restore: paths => { fs.writeFileSync(paths[0], bytes); return matched }})
    assert.equal(await f.client.lookup({execution: {key: key(1)}}), null)
    assert.equal(f.calls.length, 1); f.authRestored()
  }
  const f = fixture(t, {restore: () => undefined})
  fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, 'collection.json'), bytes)
  assert.equal(await f.client.lookup({execution: {key: key(1)}}), null)
  assert.equal(fs.existsSync(path.join(f.directory, 'collection.json')), false)
})

test('coherent malformed, obsolete, duplicate, oversized and tampered collections all miss', async t => {
  const valid = packed([[key(1), receipt(1)]])
  const mutate = update => { const value = JSON.parse(valid); update(value); return Buffer.from(JSON.stringify(value) + '\n') }
  const alternatives = [
    [Buffer.concat([valid, Buffer.from('\n')]), false],
    [mutate(value => { value.schema = 'quod-managed-collection-v0' }), true],
    [mutate(value => { value.scope = 'b'.repeat(64) }), true],
    [mutate(value => { value.extra = true }), true],
    [mutate(value => { value.entries.push(value.entries[0]) }), true],
    [mutate(value => { value.entries[0].receiptSha256 = '0'.repeat(64) }), true],
    [mutate(value => { value.entries[0].receiptBase64 += ' ' }), true],
    [Buffer.from(valid.toString().replace('{', '{"schema":"discarded",')), true],
    [Buffer.from(JSON.stringify(JSON.parse(valid), null, 2) + '\n'), true],
    [Buffer.from(JSON.stringify({schema: C.SCHEMA, scope, entries: Array.from({length: 513}, (_, i) =>
      ({executionKey: key(i + 1), receiptSha256: hash(receipt(i)), receiptBase64: receipt(i).toString('base64')}))}) + '\n'), true],
    [mutate(value => { const bytes = Buffer.alloc(C.MAX_RECEIPT_BYTES + 1, 65); value.entries[0].receiptBase64 = bytes.toString('base64'); value.entries[0].receiptSha256 = hash(bytes) }), true],
  ]
  for (const [bytes, coherent] of alternatives) {
    const f = fixture(t, {restore: paths => { fs.writeFileSync(paths[0], bytes); return C.prefix(scope, namespace) + hash(coherent ? bytes : valid) }})
    assert.equal(await f.client.lookup({execution: {key: key(1)}}), null)
    assert.deepEqual(f.calls.map(call => call.operation), ['restore'])
    assert.equal(f.events.at(-1).operation, 'collection-restore-error'); f.authRestored()
  }
  assert.throws(() => C.decode(Buffer.alloc(C.MAX_BYTES + 1), scope), /invalid collection bytes/)
})

test('failures, read-only and control commands cannot publish; control makes zero SDK calls', async t => {
  const failed = fixture(t)
  failed.record(key(1), receipt(1))
  assert.deepEqual(await failed.client.publish({exitCode: 1}), {saved: false, reason: 'command-failed'})
  assert.deepEqual(failed.calls, [])
  for (const settings of [{control: true}, {write: false}]) {
    const f = fixture(t, settings)
    assert.equal(await f.client.lookup({execution: {key: key(1)}}), null)
    assert.deepEqual(f.record(key(1), receipt(1)), {queued: false})
    assert.deepEqual(f.client.record({execution: null}), {queued: false})
    assert.equal((await f.client.publish({exitCode: 0})).saved, false)
    assert.deepEqual(f.calls.map(call => call.operation), settings.control ? [] : ['restore'])
    f.authRestored()
  }
  assert.throws(() => failed.record(key(2), receipt(2)), /finalized/)
})

test('record digest errors and conflicting new observations stickily prevent publication', async t => {
  for (const conflict of [false, true]) {
    const f = fixture(t), file = path.join(f.root, 'wrong.json')
    f.record(key(1), receipt(1))
    fs.writeFileSync(file, receipt(2))
    assert.throws(() => f.client.record({execution: {key: key(1)}, file,
      receiptSha256: conflict ? hash(receipt(2)) : '0'.repeat(64)}), /conflicting|digest/)
    assert.deepEqual(await f.client.publish({exitCode: 0}), {saved: false, reason: 'record-error'})
    assert.deepEqual(f.calls, [])
  }
  const invalid = fixture(t)
  invalid.record(key(1), receipt(1))
  assert.throws(() => invalid.client.record({execution: {key: 'not-an-execution'}}), /execution key/)
  assert.deepEqual(await invalid.client.publish({exitCode: 0}), {saved: false, reason: 'record-error'})
  assert.deepEqual(invalid.calls, [])
})

test('queued bytes are immutable and symlinked local authority is rejected', async t => {
  const f = fixture(t)
  f.record(key(1), receipt(1))
  fs.writeFileSync(path.join(f.root, `receipt-${key(1)}.json`), receipt(2))
  assert.equal((await f.client.publish({exitCode: 0})).saved, true)
  assert.deepEqual(C.decode([...f.backend.values()][0], scope).get(key(1)).bytes, receipt(1))
  const bytes = packed([[key(1), receipt(1)]])
  const link = fixture(t, {restore: paths => {
    const target = path.join(link.root, 'elsewhere.json'); fs.writeFileSync(target, bytes); fs.symlinkSync(target, paths[0])
    return C.prefix(scope, namespace) + hash(bytes)
  }})
  assert.equal(await link.client.lookup({execution: {key: key(1)}}), null)
  const directory = fixture(t)
  fs.symlinkSync(directory.root, directory.directory)
  assert.equal(await directory.client.lookup({execution: {key: key(1)}}), null)
  assert.equal(directory.calls.length, 0)
})

test('SDK errors, missing acknowledgments and save-time tampering never report publication', async t => {
  const miss = fixture(t, {restore: () => { throw new Error('fixture SDK error') }})
  assert.equal(await miss.client.lookup({execution: {key: key(1)}}), null); miss.authRestored()
  for (const save of [() => { throw new Error('fixture save error') }, () => -1, paths => { fs.writeFileSync(paths[0], 'tampered'); return 123 }]) {
    const f = fixture(t, {save})
    f.record(key(1), receipt(1))
    assert.equal((await f.client.publish({exitCode: 0})).saved, false)
    assert.equal(f.events.at(-1).operation, 'collection-save-error'); f.authRestored()
  }
})

test('publication remains pending until the single SDK save is acknowledged', async t => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, {save: async () => { entered(); await new Promise(resolve => { release = resolve }); return 123 }})
  f.record(key(1), receipt(1))
  let completed = false
  const result = f.client.publish({exitCode: 0}).then(value => { completed = true; return value })
  await started
  assert.equal(completed, false)
  assert.deepEqual(f.calls.map(call => call.operation), ['restore', 'save'])
  release()
  assert.equal((await result).saved, true); f.authRestored()
})
