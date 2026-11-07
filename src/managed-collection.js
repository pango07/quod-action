'use strict'
// Unused by the v1 bridge until the matrix dispatcher is integrated. A service
// key authenticates the whole collection; per-execution receipt admission is
// still the runtime ledger's job. Local files or manifest claims never seed it.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SCHEMA = 'quod-managed-collection-v1'
const MAX_ENTRIES = 512, MAX_RECEIPT_BYTES = 2 * 1024 * 1024, MAX_BYTES = 32 * 1024 * 1024
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function fields(value, names) {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}
function prefix(scope, namespace = '') {
  if (!digest(scope) || typeof namespace !== 'string' || !/^(?:[A-Za-z0-9._-]{1,80}-)?$/.test(namespace)) throw new Error('invalid managed collection scope')
  return `${SCHEMA}-${namespace}${scope}-`
}
function serviceDigest(key, scope, namespace = '') {
  const start = prefix(scope, namespace)
  return typeof key === 'string' && key.startsWith(start) && digest(key.slice(start.length)) ? key.slice(start.length) : null
}
function encode(scope, entries) {
  const rows = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([executionKey, value]) => ({executionKey, receiptSha256: value.receiptSha256, receiptBase64: value.bytes.toString('base64')}))
  const bytes = Buffer.from(JSON.stringify({schema: SCHEMA, scope, entries: rows}) + '\n')
  if (rows.length > MAX_ENTRIES || bytes.length > MAX_BYTES) throw new Error('managed collection bound exceeded')
  return bytes
}
function decode(bytes, scope) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('invalid collection bytes')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!fields(value, ['schema', 'scope', 'entries']) || value.schema !== SCHEMA || value.scope !== scope ||
      !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw new Error('invalid collection schema')
  const entries = new Map()
  let previous = ''
  for (const row of value.entries) {
    if (!fields(row, ['executionKey', 'receiptSha256', 'receiptBase64']) || !digest(row.executionKey) || !digest(row.receiptSha256) ||
        row.executionKey <= previous || typeof row.receiptBase64 !== 'string' || row.receiptBase64.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4) throw new Error('invalid collection entry')
    const body = Buffer.from(row.receiptBase64, 'base64')
    if (!body.length || body.length > MAX_RECEIPT_BYTES || body.toString('base64') !== row.receiptBase64 || sha(body) !== row.receiptSha256) throw new Error('invalid collection receipt bytes')
    entries.set(row.executionKey, {bytes: body, receiptSha256: row.receiptSha256})
    previous = row.executionKey
  }
  // Also rejects duplicate JSON keys, unknown fields, noncanonical encodings,
  // alternate ordering/whitespace and coherently redigested malformed records.
  if (!encode(scope, entries).equals(bytes)) throw new Error('noncanonical managed collection')
  return entries
}
function privateDirectory(directory) {
  try { fs.mkdirSync(directory, {mode: 0o700}) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const st = fs.lstatSync(directory)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe managed collection directory')
  fs.chmodSync(directory, 0o700)
}
function readRegular(file, maximum) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > maximum) throw new Error('invalid managed collection file')
  const bytes = fs.readFileSync(file)
  if (bytes.length !== st.size) throw new Error('managed collection file changed')
  return bytes
}

function createManagedCollection({sdk, withCacheAuth, directory, scope, namespace = '', control = false, write = false, onTransport = () => {}}) {
  const start = prefix(scope, namespace)
  if (!sdk || typeof sdk.restoreCache !== 'function' || typeof sdk.saveCache !== 'function' || typeof withCacheAuth !== 'function' ||
      typeof directory !== 'string' || !path.isAbsolute(directory) || typeof control !== 'boolean' || typeof write !== 'boolean' || typeof onTransport !== 'function') throw new Error('invalid collection options')
  const file = path.join(directory, 'collection.json')
  let restorePromise, publishPromise, finalized = false, tainted = false, pendingBytes = 0
  let loaded = new Map(), matchedServiceKey = null, collectionSha256 = null
  const requested = new Set(), pending = new Map()
  const emit = event => onTransport(event)
  const executionKey = execution => {
    if (!object(execution) || !digest(execution.key)) throw new Error('invalid managed execution key')
    return execution.key
  }
  const ensureRestored = () => {
    if (control) return Promise.resolve()
    if (!restorePromise) restorePromise = (async () => {
      let matched
      try {
        privateDirectory(directory)
        // A service miss cannot accidentally authenticate a prior local file.
        fs.rmSync(file, {force: true})
        matched = await withCacheAuth(() => sdk.restoreCache([file], start + 'lookup', [start]))
      } catch {
        emit({operation: 'collection-restore-error', reason: 'sdk-or-local-io'}); return
      }
      const trusted = serviceDigest(matched, scope, namespace)
      if (!trusted) {
        emit({operation: 'collection-restore', matchedServiceKey: null, collectionSha256: null, entries: 0,
          reason: matched ? 'invalid-service-key' : 'miss'}); return
      }
      try {
        const bytes = readRegular(file, MAX_BYTES)
        if (sha(bytes) !== trusted) throw new Error('collection digest mismatch')
        loaded = decode(bytes, scope)
        matchedServiceKey = matched; collectionSha256 = trusted
      } catch {
        loaded = new Map()
        emit({operation: 'collection-restore-error', reason: 'invalid-authenticated-bytes'}); return
      }
      emit({operation: 'collection-restore', matchedServiceKey, collectionSha256, entries: loaded.size, reason: 'hit'})
    })()
    return restorePromise
  }
  async function lookupBytes({execution}) {
    if (finalized) throw new Error('managed collection already finalized')
    const key = executionKey(execution)
    if (control) return null
    requested.add(key)
    await ensureRestored()
    const value = loaded.get(key)
    if (!value) return null
    emit({operation: 'collection-entry', executionKey: key, matchedServiceKey, collectionSha256, receiptSha256: value.receiptSha256})
    // The caller must still validate this exact current execution/instance in
    // the runtime ledger. Return a copy so a consumer cannot mutate the pack.
    return {receiptBytes: Buffer.from(value.bytes), trustedReceiptSha256: value.receiptSha256}
  }
  async function lookup({execution}) {
    const value = await lookupBytes({execution})
    if (!value) return null
    const key = executionKey(execution)
    const entriesDir = path.join(directory, 'entries'), entryDir = path.join(entriesDir, key)
    privateDirectory(entriesDir); privateDirectory(entryDir)
    const receipt = path.join(entryDir, 'receipt.json')
    fs.rmSync(receipt, {force: true})
    fs.writeFileSync(receipt, value.receiptBytes, {mode: 0o600, flag: 'wx'})
    return {file: receipt, trustedReceiptSha256: value.trustedReceiptSha256}
  }
  function record({execution, file: receipt, receiptSha256}) {
    if (finalized) throw new Error('managed collection already finalized')
    if (control || !write) return {queued: false}
    try {
      const key = executionKey(execution)
      if (!digest(receiptSha256) || typeof receipt !== 'string') throw new Error('invalid recorded receipt')
      const bytes = readRegular(receipt, MAX_RECEIPT_BYTES)
      if (sha(bytes) !== receiptSha256) throw new Error('recorded receipt digest mismatch')
      const previous = pending.get(key)
      if (previous && previous.receiptSha256 !== receiptSha256) throw new Error('conflicting managed receipts')
      if (!previous && pending.size >= MAX_ENTRIES) throw new Error('managed collection entry bound exceeded')
      if (!previous && pendingBytes + bytes.length > MAX_BYTES) throw new Error('managed collection byte bound exceeded')
      if (!previous) pendingBytes += bytes.length
      pending.set(key, {bytes, receiptSha256})
      return {queued: true, executionKey: key, receiptSha256}
    } catch (error) { tainted = true; throw error }
  }
  function publish({exitCode}) {
    if (publishPromise) return publishPromise
    finalized = true
    publishPromise = (async () => {
      if (control || !write || exitCode !== 0 || tainted || !pending.size) return {saved: false,
        reason: control ? 'control' : !write ? 'read-only' : exitCode !== 0 ? 'command-failed' : tainted ? 'record-error' : 'no-new-receipts'}
      await ensureRestored()
      // Preserve requested hits and every new record. Unused history is dropped,
      // keeping future matrix collections bounded without discarding this run.
      const entries = new Map([...loaded].filter(([key]) => requested.has(key)))
      for (const [key, value] of pending) entries.set(key, value)
      let bytes
      try { bytes = encode(scope, entries) }
      catch { emit({operation: 'collection-save-error', reason: 'collection-bound'}); return {saved: false, reason: 'collection-bound'} }
      const bodySha = sha(bytes), key = start + bodySha
      try {
        privateDirectory(directory); fs.rmSync(file, {force: true})
        fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'})
        const cacheId = await withCacheAuth(() => sdk.saveCache([file], key))
        if (!Number.isSafeInteger(cacheId) || cacheId <= 0 || sha(readRegular(file, MAX_BYTES)) !== bodySha) throw new Error('unacknowledged or changed collection')
        emit({operation: 'collection-save', key, collectionSha256: bodySha, entries: entries.size, cacheId})
        return {saved: true, collectionSha256: bodySha, entries: entries.size, cacheId}
      } catch {
        emit({operation: 'collection-save-error', reason: 'sdk-or-local-io'})
        return {saved: false, reason: 'sdk-or-local-io'}
      }
    })()
    return publishPromise
  }
  return {lookupBytes, lookup, record, publish}
}

module.exports = {SCHEMA, MAX_ENTRIES, MAX_RECEIPT_BYTES, MAX_BYTES, prefix, serviceDigest, encode, decode, createManagedCollection}
