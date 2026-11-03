'use strict'
// What main and post share: where things live, and the ledger's cache keys.
const fs = require('node:fs')
const path = require('node:path')

const base = path.join(process.env.RUNNER_TEMP || '/tmp', 'quod')
const paths = {
  base,
  ledgers: path.join(base, 'vitest'),
  reports: path.join(base, 'reports'),
  hook: path.join(base, 'hook.cjs'),
  config: path.join(base, 'config.json'),
}

function event() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  } catch {
    return {}
  }
}

// The branch and commit the ledger is for, and the branches whose ledgers
// may stand in for it: the same in the CI job (push or pull_request) and in
// the shadow (workflow_run of that CI run).
function scope() {
  const e = event()
  const name = process.env.GITHUB_EVENT_NAME
  const fallback = e.repository?.default_branch
  if (name === 'workflow_run') {
    const run = e.workflow_run ?? {}
    return {
      branch: run.head_branch,
      sha: run.head_sha,
      base: run.pull_requests?.[0]?.base?.ref,
      fallback,
      runId: run.id,
      trusted: run.head_repository?.full_name === e.repository?.full_name,
    }
  }
  if (e.pull_request) {
    return {
      branch: process.env.GITHUB_HEAD_REF,
      sha: e.pull_request.head?.sha,
      base: process.env.GITHUB_BASE_REF,
      fallback,
      trusted: e.pull_request.head?.repo?.full_name === e.repository?.full_name,
    }
  }
  return { branch: process.env.GITHUB_REF_NAME, sha: process.env.GITHUB_SHA, fallback, trusted: true }
}

// A cache entry is immutable: each job that records saves its own (run,
// attempt, job), so a re-run of a commit, which may be its second witness,
// is kept too; a restore takes the newest under the branch's prefix.
function keys(s) {
  const k = (b) => `quod-vitest-${b}-`
  const restore = [...new Set([s.branch, s.base, s.fallback].filter(Boolean).map(k))]
  const job = [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.env.GITHUB_JOB].filter(Boolean).join('-')
  return { key: `${k(s.branch)}${s.sha}${job ? `-${job}` : ''}`, restore }
}

module.exports = { paths, scope, keys }
