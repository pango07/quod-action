'use strict'
// After the job: in the CI job, hand the tests' reports to the shadow (an
// artifact of this run); in the shadow, save the ledger it recorded.
const core = require('@actions/core')
const cache = require('@actions/cache')
const { DefaultArtifactClient } = require('@actions/artifact')
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./common')

async function run() {
  if (core.getState('active') !== '1') return
  const mode = core.getState('mode')
  if (mode === 'check') {
    const files = fs.existsSync(paths.reports)
      ? fs.readdirSync(paths.reports).filter((f) => f.endsWith('.json')).map((f) => path.join(paths.reports, f))
      : []
    if (!files.length) return
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
    await cache.saveCache([paths.ledgers], key)
    core.info(`Quod: saved the recording as ${key}`)
  }
}

run().catch((e) => core.warning(`Quod: ${e.message}`))
