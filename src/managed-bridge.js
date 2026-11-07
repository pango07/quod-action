'use strict'
// Runs outside the managed worker. Only an authenticated Actions cache service
// response supplies a receipt digest. Local receipt metadata is not authority.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const {pathToFileURL} = require('node:url')
const {spawnSync} = require('node:child_process')
const cache = require('@actions/cache')
const {receiptPrefix, trustedDigest} = require('./managed-cache')
const {loadCacheAuth, withCacheAuth} = require('./managed-auth')
// ncc rewrites ordinary dynamic import expressions into CommonJS require.
// This loader deliberately retains Node's native ESM import for the separately
// shipped, content-pinned runtime. No project source becomes loader code.
const importRuntime = new Function('specifier', 'return import(specifier)')
let dispatchStarted = false

async function main() {
  const [configFile, vitestEntry, ...args] = process.argv.slice(2)
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  const managed = cfg.managed
  const cacheAuth = loadCacheAuth(managed.cacheAuth)
  const base = path.dirname(configFile)
  const out = fs.mkdtempSync(path.join(base, 'managed-run-'))
  const cacheDir = path.join(base, 'managed-receipts')
  const transport = []
  const retainTransport = event => {
    if (event) transport.push(event)
    fs.writeFileSync(path.join(out, 'cache-transport.json'), JSON.stringify({schema: 'quod-managed-action-cache-v1', events: transport}, null, 2) + '\n')
  }
  const {dispatchManaged} = await importRuntime(pathToFileURL(path.join(managed.runtime, 'dispatcher.mjs')).href)
  if (typeof dispatchManaged !== 'function') throw new Error('managed dispatcher export missing')
  dispatchStarted = true
  const result = await dispatchManaged({project: cfg.root, out, cacheDir, args, vitestEntry,
    node: process.execPath, control: managed.mode === 'control', epoch: managed.epoch,
    seed: managed.seed, env: managed.env,
    async lookup({execution}) {
      const prefix = receiptPrefix(execution.key, managed.namespace)
      const dir = path.join(cacheDir, execution.key)
      fs.mkdirSync(dir, {recursive: true})
      try {
        // Cache entries are immutable and scoped by GitHub's branch/ref rules.
        // The returned key is from the service, never a downloaded manifest.
        const matched = await withCacheAuth(cacheAuth, () => cache.restoreCache([dir], prefix + 'lookup', [prefix]))
        const digest = trustedDigest(matched, execution.key, managed.namespace)
        retainTransport({operation: 'restore', executionKey: execution.key, prefix,
          matchedServiceKey: matched || null, trustedReceiptSha256: digest,
          file: path.join(dir, 'receipt.json')})
        if (!digest) return null
        return {file: path.join(dir, 'receipt.json'), trustedReceiptSha256: digest}
      } catch (error) {
        retainTransport({operation: 'restore-error', executionKey: execution.key})
        console.error(`quod managed: receipt restore missed (${error.message})`)
        return null
      }
    },
    async record({execution, file, receiptSha256}) {
      if (!managed.write || managed.mode === 'control') return
      const bytes = fs.readFileSync(file)
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== receiptSha256) throw new Error('receipt changed before save')
      const dir = path.join(cacheDir, execution.key)
      fs.mkdirSync(dir, {recursive: true})
      fs.writeFileSync(path.join(dir, 'receipt.json'), bytes, {mode: 0o600})
      try {
        const key = receiptPrefix(execution.key, managed.namespace) + receiptSha256
        const cacheId = await withCacheAuth(cacheAuth, () => cache.saveCache([dir], key))
        retainTransport({operation: 'save', executionKey: execution.key, key, receiptSha256,
          cacheId: Number.isSafeInteger(cacheId) ? cacheId : null})
      } catch (error) {
        retainTransport({operation: 'save-error', executionKey: execution.key})
        console.error(`quod managed: receipt not saved (${error.message})`)
      }
    }})
  retainTransport()
  console.log(`QUOD_MANAGED_RESULT ${JSON.stringify({mode: result.mode, files: result.files.map(file => ({file: file.file, decision: file.decision})),
    hit: result.hit, managedExecutions: result.managedExecutions, fallback: result.fallback, exitCode: result.exitCode,
    effectsSha256: result.effectsSha256 || null, runtimeClassSha256: result.runtimeClassSha256 || null,
    nativeFingerprintSha256: result.nativeFingerprintSha256 || null,
    executionKey: result.executionKey || null, commandSeconds: result.commandSeconds, evidenceDirectory: out})}`)
  return result.exitCode
}

main().then(code => { process.exitCode = Number.isInteger(code) ? code : 1 }).catch(error => {
  // A late report/IO exception must never erase an already observed failure by
  // retrying the test into a pass. The dispatcher handles supported declines.
  if (dispatchStarted) {
    console.error(`quod managed: dispatcher stopped (${error.message}); failing the command`)
    process.exitCode = 1
    return
  }
  console.error(`quod managed: dispatcher unavailable (${error.message}); running original Vitest`)
  const [, vitestEntry, ...args] = process.argv.slice(2)
  const ordinary = spawnSync(process.execPath, [vitestEntry, ...args], {
    stdio: 'inherit', env: {...process.env, QUOD_SHIM_ACTIVE: '1'}})
  process.exitCode = ordinary.status ?? 1
})
