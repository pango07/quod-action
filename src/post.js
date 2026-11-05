'use strict'
// After the job: remove the config (it holds GitHub's OIDC request token
// for quod); save the ledger the job recorded to the Actions cache (the
// check job, or the older shadow); a read-only check job (`record: false`)
// hands its tests' reports to the shadow (an artifact of this run).
const core = require('@actions/core')
const cache = require('@actions/cache')
const { DefaultArtifactClient } = require('@actions/artifact')
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./common')
const D = require('../deps.cjs')
const { saveTogether } = require('./saves')

// Credentials the job holds: none of their values may leave in a report
// artifact or a cached ledger.
const CREDENTIALS = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL', 'QUOD_SERVER_TOKEN']
function leaks(files) {
  const secrets = CREDENTIALS.map((k) => [k, process.env[k]]).filter(([, v]) => v && v.length >= 16)
  const task = core.getState('task-token')
  if (task) secrets.push(['the task-cache session', task])
  for (const f of files) {
    let b
    try {
      b = fs.readFileSync(f)
    } catch {
      continue
    }
    for (const [k, v] of secrets) if (b.includes(v)) return k
  }
  return null
}
function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

// Saves what the install put down, when this job installed it and nothing
// outside the key can have gone into it (deps.cjs).
async function dependencies() {
  const raw = core.getState('deps')
  if (!raw) return
  const st = JSON.parse(raw)
  if (st.hit === 'exact' || st.hit === 'preexisting') return
  if (!st.save) return core.info(`Quod dependencies: a ${process.env.GITHUB_EVENT_NAME} job does not save (it may run someone else's code on the base branch's cache scope)`)
  if (st.pm === 'npm') {
    let installed = null
    try {
      installed = JSON.parse(fs.readFileSync(path.join(paths.base, 'deps-installed.json'), 'utf8'))
    } catch {}
    if (!installed) return core.info('Quod dependencies: no `npm ci` finished in this job; nothing saved')
    if (installed.key !== st.key) return core.info('Quod dependencies: the install ran on other inputs than the job started with; nothing saved')
    const unsafe = D.npmUnsafe(st.root)
    if (unsafe) return core.info(`Quod dependencies: node_modules is not saved: ${unsafe}`)
    if (D.fullPrint(st.ws, st.paths) !== installed.print) return core.info('Quod dependencies: node_modules changed after `npm ci`; not saved')
    fs.writeFileSync(path.join(st.root, 'node_modules', '.quod-deps.json'), JSON.stringify({ key: st.key, args: installed.args, npm: st.facts.npm }))
    const t0 = Date.now()
    const uploads = await saveTogether([
      () => cache.saveCache(st.paths.slice(), st.cacheKey),
      async () => {
        if (st.npmCache && st.npmCache.hit !== 'exact') {
          await cache.saveCache([st.npmCache.path], st.npmCache.key)
        }
      },
    ])
    if (uploads[1].status === 'rejected') core.info(`Quod dependencies: npm's download cache not saved (${uploads[1].reason.message})`)
    if (uploads[0].status === 'rejected') throw uploads[0].reason
    core.info(`Quod dependencies: node_modules saved for this lockfile (${st.key.slice(0, 12)}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    return
  }
  let filled = false
  try {
    filled = fs.readdirSync(st.paths[0]).length > 0
  } catch {}
  if (!filled) return
  const t0 = Date.now()
  await cache.saveCache(st.paths.slice(), st.cacheKey)
  core.info(`Quod dependencies: ${st.pm}'s store saved in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

async function run() {
  if (core.getState('active') !== '1') return
  const results = await saveTogether([dependencies, saveTests])
  if (results[0].status === 'rejected') core.info(`Quod dependencies: not saved (${results[0].reason.message})`)
  if (results[1].status === 'rejected') throw results[1].reason
}

async function saveTests() {
  const mode = core.getState('mode')
  if (core.getState('vitest') !== '1') {
    // main said why (a failed quod install, an unsupported runner, ...).
    core.info('Quod was off for vitest in this job (see the quod step): tests ran as plain vitest; nothing recorded, nothing saved')
    return
  }
  if (mode === 'check' && core.getState('record') === '1') {
    // The ledger this job recorded, for the next job (Quod Cloud has it
    // already when the job could use it; the cache is the fallback).
    await saveLedger()
    return
  }
  if (mode === 'check') {
    const files = fs.existsSync(paths.reports)
      ? fs.readdirSync(paths.reports).filter((f) => f.endsWith('.json') && f !== 'quod.json').map((f) => path.join(paths.reports, f))
      : []
    if (!files.length) return
    // Which quod ran here: the shadow records with the same one.
    const meta = path.join(paths.reports, 'quod.json')
    fs.writeFileSync(meta, core.getState('version'))
    files.push(meta)
    const leak = leaks(files)
    if (leak) {
      core.warning(`Quod: the test reports contain the value of ${leak}; not uploaded (the shadow records nothing)`)
      return
    }
    const name = `quod-vitest-reports-${process.env.GITHUB_JOB}${process.env.GITHUB_RUN_ATTEMPT > 1 ? `-${process.env.GITHUB_RUN_ATTEMPT}` : ''}`
    await new DefaultArtifactClient().uploadArtifact(name, files, paths.reports, { retentionDays: 3 })
    core.info(`Quod: ${files.length} test reports for the shadow (${name})`)
    return
  }
  if (mode === 'shadow') await saveLedger()
}

async function saveLedger() {
  const key = core.getState('key')
  // Every vitest run of this job emitted a full replay (the hook marks one
  // that recorded): the restored ledger is the newest; nothing to save.
  if (core.getState('mode') === 'check' && !fs.existsSync(path.join(paths.base, 'recorded'))) {
    core.info('Quod: nothing recorded in this job (every vitest run replayed in full); the ledger is not saved again')
    return
  }
  if (core.getState('hit') === 'exact') {
    core.info(`Quod: ${key} is already saved`)
    return
  }
  if (!fs.existsSync(paths.ledgers) || !walk(paths.ledgers).some((f) => f.endsWith('ledger.json'))) {
    core.info('Quod: no ledger recorded in this job')
    return
  }
  const leak = leaks(walk(paths.ledgers))
  if (leak) {
    core.warning(`Quod: the ledger contains the value of ${leak}; not saved to the Actions cache`)
    return
  }
  await cache.saveCache([paths.ledgers], key)
  core.info(`Quod: saved the recording as ${key}`)
}

run()
  .catch((e) => core.warning(`Quod: ${e.message}`))
  .finally(() => {
    // Always, whatever happened above.
    try {
      fs.rmSync(paths.config, { force: true })
    } catch {}
  })
