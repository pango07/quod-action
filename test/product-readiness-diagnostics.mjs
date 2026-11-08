// Post-command diagnostics only. Never admit replay or publish a raw private file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fixture, ledgerDirectory, sha, SUITE, summaryFile} from './product-readiness-common.mjs'

const MAX_KEYS = 2048, MAX_OUTPUT = 256 * 1024
const FILES = ['tests/inputs.test.js', 'tests/math.test.js']
const KINDS = new Set(['f', 'pj', 'pjf', 'pjq', 'st', 'sm', 'sl', 'd', 'r', 'rj', 'e', 'rp', 'p', 'rc',
  'env', 'envp', 'envall', 'envtool',
  ...Array.from({length: 8}, (_, i) => `a${i}`), ...Array.from({length: 8}, (_, i) => `ae${i}`)])
const NUMBERS = ['recorded_files', 'ran', 'replayed', 'audited', 'inputs_hashed', 'witnesses_needed',
  'provisional', 'promoted', 'witnessed_again', 'witness_disagreed', 'exit', 'narrowed',
  'timing_sensitive_replays', 'lineage_promoted', 'lineage_audits', 'lineage_disagreed', 'lineage_revoked']
const own = (value, key) => Object.hasOwn(value, key)
const integer = (value, max = Number.MAX_SAFE_INTEGER) => assert(Number.isSafeInteger(value) && value >= 0 && value <= max)
const string = (value, max = 16384) => assert(typeof value === 'string' && Buffer.byteLength(value) <= max)
const object = value => assert(value && typeof value === 'object' && !Array.isArray(value))
const boolean = value => assert(typeof value === 'boolean')
const kind = key => {const prefix = key.split(':', 1)[0]; return KINDS.has(prefix) ? prefix : 'other'}
const canonical = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))

function read(file, maximum, optional = false) {
  assert(fs.realpathSync(path.dirname(file)) === path.resolve(path.dirname(file)))
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(fd)
    assert(before.isFile() && before.size > 0 && before.size <= maximum)
    const body = Buffer.alloc(maximum + 1)
    let size = 0, count
    do {count = fs.readSync(fd, body, size, body.length - size, null); size += count} while (count && size < body.length)
    const after = fs.fstatSync(fd)
    assert(size === before.size && size <= maximum && after.size === before.size && after.mtimeMs === before.mtimeMs)
    return JSON.parse(body.subarray(0, size).toString('utf8'))
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw error
  } finally {if (fd !== undefined) fs.closeSync(fd)}
}

function capture(operation) {
  try {return {available: true, ...operation()}}
  catch (error) {return {available: false, decline: error.code === 'ENOENT' ? 'missing' : 'bounded-read-or-schema'}}
}

function fileName(value) {
  string(value, 4096)
  const found = FILES.find(file => value === file || value === path.join(fixture(), file))
  assert(found, 'only the two public fixture files may be named')
  return found
}

function summaryEvidence() {
  const value = read(summaryFile(), 256 * 1024); object(value)
  const numbers = {}
  for (const name of NUMBERS) if (own(value, name)) {integer(value[name]); numbers[name] = value[name]}
  let changed = null
  if (own(value, 'shared_changed_keys')) {
    assert(Array.isArray(value.shared_changed_keys) && value.shared_changed_keys.length <= 20)
    changed = value.shared_changed_keys.map(key => {string(key); return {kind: kind(key), keySha256: sha(key)}})
  }
  let unrecordable = null
  if (own(value, 'unrecordable')) {
    object(value.unrecordable); assert(Object.keys(value.unrecordable).length <= 32)
    unrecordable = Object.entries(value.unrecordable).map(([reason, count]) => {
      string(reason); integer(count); return {reasonSha256: sha(reason), count}
    }).sort((a, b) => a.reasonSha256.localeCompare(b.reasonSha256))
  }
  for (const name of ['fast', 'shared_inputs_changed']) if (own(value, name)) boolean(value[name])
  return {numbers, absentNumbers: NUMBERS.filter(name => !own(value, name)), sharedChangedKeys: changed,
    sharedInputsChanged: value.shared_inputs_changed ?? null, fast: value.fast ?? null, unrecordable}
}

function ledgerEvidence() {
  const value = read(path.join(ledgerDirectory(), 'ledger.json'), 4 * 1024 * 1024); object(value)
  assert(Array.isArray(value.keys) && value.keys.length <= MAX_KEYS && Array.isArray(value.states) && value.states.length === value.keys.length)
  assert(new Set(value.keys).size === value.keys.length)
  const keyStates = value.keys.map((key, index) => {
    string(key); string(value.states[index]); return [kind(key), sha(key), sha(value.states[index])]
  })
  const indices = rows => {
    assert(Array.isArray(rows) && rows.length <= MAX_KEYS && new Set(rows).size === rows.length)
    for (const index of rows) integer(index, keyStates.length - 1)
    return [...rows]
  }
  object(value.files); assert(Object.keys(value.files).length === 2)
  const records = Object.values(value.files).map(record => {
    object(record); object(record.w); object(record.pinned)
    const file = fileName(record.file)
    assert(['pass', 'fail', 'skip', 'todo'].includes(record.state))
    for (const name of ['quarantined', 'near_timeout', 'net']) boolean(record[name])
    for (const number of [record.plain_n, record.w.n, record.w.disagreements]) integer(number)
    string(record.w.key); string(record.w.tests)
    const pinnedOverrides = Object.entries(record.pinned).map(([key, state]) => {
      assert(/^(0|[1-9][0-9]*)$/.test(key)); const index = Number(key); integer(index, keyStates.length - 1)
      string(state); return [index, sha(state)]
    }).sort((a, b) => a[0] - b[0])
    assert(pinnedOverrides.length <= MAX_KEYS)
    return {file, state: record.state, quarantined: record.quarantined, nearTimeout: record.near_timeout,
      networkObserved: record.net, lineagePresent: record.lineage !== null && record.lineage !== undefined,
      plainWitnesses: record.plain_n, witnesses: record.w.n, disagreements: record.w.disagreements,
      witnessKeyEmpty: record.w.key.length === 0, witnessKeySha256: sha(record.w.key), witnessTestsSha256: sha(record.w.tests),
      dependencyIndices: indices(record.deps), pinnedOverrides}
  }).sort((a, b) => a.file.localeCompare(b.file))
  assert(JSON.stringify(records.map(record => record.file)) === JSON.stringify(FILES))
  string(value.code); object(value.facts); assert(Object.keys(value.facts).length <= 128)
  for (const [key, state] of Object.entries(value.facts)) {string(key, 256); string(state)}
  return {codeSha256: sha(value.code), factsSha256: sha(canonical(value.facts)),
    keyStateColumns: ['kind', 'keySha256', 'stateSha256'], keyStates,
    globalIndices: indices(value.global), records}
}

function planEvidence() {
  const value = read(path.join(ledgerDirectory(), 'plan.json'), 256 * 1024); object(value)
  for (const name of ['record', 'hooks', 'netWitness']) boolean(value[name])
  const members = rows => {
    if (rows === null) return null
    assert(Array.isArray(rows) && rows.length <= 2)
    const expected = []; let other = 0
    for (const name of rows) {
      string(name, 4096)
      const file = FILES.find(file => name === file || name === path.join(fixture(), file))
      if (file) expected.push(file)
      else other++
    }
    return {count: rows.length, expectedFiles: expected.sort(), otherCount: other}
  }
  object(value.replay); assert(Object.keys(value.replay).length <= 2)
  assert(Array.isArray(value.audit) && value.audit.length <= 2)
  return {record: value.record, hooks: value.hooks, networkWitnessMode: value.netWitness,
    plain: members(value.plain), coverage: members(value.cov), deniedNetwork: members(value.deny),
    replayCount: Object.keys(value.replay).length, auditCount: value.audit.length}
}

function restoreEvidence() {
  const value = read(path.join(ledgerDirectory(), '.quod-cloud-restore.json'), 64 * 1024, true)
  if (value === null) return {present: false}
  object(value); object(value.used); boolean(value.used.found); string(value.tag, 4096)
  assert(value.used.id === null || Number.isSafeInteger(value.used.id) && value.used.id > 0)
  assert(value.used.sha === null || typeof value.used.sha === 'string' && /^[a-f0-9]{40}$/.test(value.used.sha))
  return {present: true, found: value.used.found, id: value.used.id, sha: value.used.sha,
    tagMatchesCurrentJob: value.tag === `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}/${process.env.GITHUB_JOB}/${SUITE}`}
}

export function captureProductDiagnostics() {
  try {
    const result = {schema: 'quod-product-native-post-command-diagnostics-v1',
      snapshot: 'after-command-and-ledger-update-not-incoming-trust', maxKeys: MAX_KEYS,
      summary: capture(summaryEvidence), ledger: capture(ledgerEvidence), plan: capture(planEvidence), restore: capture(restoreEvidence)}
    // Index references point into keyStates. A per-file pinnedOverrides entry
    // replaces that table's state for the same index. No raw key/state leaves.
    if (Buffer.byteLength(JSON.stringify({diagnostics: result}, null, 2)) > MAX_OUTPUT)
      result.ledger = {available: false, decline: 'ledger-output-cap', maxBytes: MAX_OUTPUT}
    if (Buffer.byteLength(JSON.stringify({diagnostics: result}, null, 2)) > MAX_OUTPUT) return {
      schema: result.schema, available: false, decline: 'diagnostic-output-cap', maxBytes: MAX_OUTPUT}
    return result
  } catch {return {schema: 'quod-product-native-post-command-diagnostics-v1', available: false, decline: 'diagnostic-capture'}}
}
