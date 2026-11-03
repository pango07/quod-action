'use strict'
// After the job: remove the config (it holds GitHub's OIDC request token
// for quod); in the CI job, hand the tests' reports to the shadow (an
// artifact of this run); in the shadow, save the ledger it recorded.
const core = require('@actions/core')
const cache = require('@actions/cache')
const { DefaultArtifactClient } = require('@actions/artifact')
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./common')

// Credentials the job holds: none of their values may leave in a report
// artifact or a cached ledger.
const CREDENTIALS = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL', 'QUOD_SERVER_TOKEN']
function leaks(files) {
  const secrets = CREDENTIALS.map((k) => [k, process.env[k]]).filter(([, v]) => v && v.length >= 16)
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

async function run() {
  if (core.getState('active') !== '1') return
  const mode = core.getState('mode')
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
  if (mode === 'shadow') {
    const key = core.getState('key')
    if (core.getState('hit') === 'exact') {
      core.info(`Quod: ${key} is already saved`)
      return
    }
    const leak = fs.existsSync(paths.ledgers) ? leaks(walk(paths.ledgers)) : null
    if (leak) {
      core.warning(`Quod: the ledger contains the value of ${leak}; not saved to the Actions cache`)
      return
    }
    await cache.saveCache([paths.ledgers], key)
    core.info(`Quod: saved the recording as ${key}`)
  }
}

run()
  .catch((e) => core.warning(`Quod: ${e.message}`))
  .finally(() => {
    // Always, whatever happened above.
    try {
      fs.rmSync(paths.config, { force: true })
    } catch {}
  })
