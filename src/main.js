'use strict'
// Installs quod, restores the most recent recording (the ledger) and puts
// the vitest shim (hook.cjs, through a node shim on PATH) for the rest of the job. Any
// failure here leaves the job as it was: plain vitest.
const core = require('@actions/core')
const cache = require('@actions/cache')
const { DefaultArtifactClient } = require('@actions/artifact')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { paths, scope, keys } = require('./common')

// SHA-256 of each release's quod-linux-x86_64.tar.gz.
const PINS = {
  'bin-cd358c8': 'f7bd0b7b33437582a2fd6d592ea286c6aae6a66195a13310223dc51e037c5d19',
  'bin-a084b71': 'c0ff034eecf8154af122440e9ff48f1ffcdeddbb0a2f495ce5ef71af20129519',
  'bin-c63b245': '2824e80e11aa530f098318d791a5134ff7c32f9ce99005fadbb6641f643148cd',
  'bin-80284fe': '4b7d2cf542956168133d9427531d941f2b227a5c16bcc93e3d20d00062555ee7',
  'bin-0f9ef16': '4035f02e13977e7e4b9d29c67212d2d2cf6c26119c60337a585a70c9ecb876e0',
  'bin-0602b10': '0f0650b7cbcb024b1fc459d45ed96ea76ac4b330b380de4163cb6cf4a8824bea',
  'bin-d03fb70': '3208a79fda5e4d66a3225428fd215b4a8d0726e376da13c7d019a358d9b50840',
}

async function install(version, want) {
  const dir = path.join(process.env.RUNNER_TOOL_CACHE || paths.base, 'quod', version)
  const bin = path.join(dir, 'quod')
  if (fs.existsSync(bin)) return bin
  const url = `https://github.com/pango07/ci-bench/releases/download/${version}/quod-linux-x86_64.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(body).digest('hex')
  if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`)
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, 'quod.tar.gz')
  fs.writeFileSync(tgz, body)
  execFileSync('tar', ['-xzf', tgz, '-C', dir])
  fs.rmSync(tgz)
  return bin
}

async function run() {
  const mode = core.getInput('mode') || 'check'
  core.saveState('mode', mode)
  if (process.env.QUOD_DISABLE === '1') {
    core.info('QUOD_DISABLE=1: tests run as plain vitest')
    return
  }
  if (!['check', 'shadow'].includes(mode)) throw new Error(`mode must be check or shadow, not ${mode}`)
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    core.warning(`Quod runs on Linux x64 runners so far (this is ${process.platform}-${process.arch}); tests run as plain vitest`)
    return
  }
  const s = scope()
  if (mode === 'shadow' && !s.trusted) {
    // A fork's code must not write a ledger every branch reads.
    core.notice('Quod: not recording a fork pull request (its code is not trusted to write the ledger)')
    return
  }
  const version = core.getInput('version')
  const want = core.getInput('sha256') || PINS[version]
  if (!want) throw new Error(`no sha256 for ${version}: set the sha256 input`)
  const quod = await install(version, want)
  core.info(`quod ${version} at ${quod}`)

  fs.mkdirSync(paths.ledgers, { recursive: true })
  fs.mkdirSync(paths.reports, { recursive: true })
  const k = keys(s)
  core.saveState('key', k.key)
  const hit = await cache.restoreCache([paths.ledgers], k.key, k.restore)
  core.saveState('hit', hit === k.key ? 'exact' : hit ? 'prefix' : '')
  core.info(hit ? `Quod: the recording ${hit}` : 'Quod: no recording yet; every test file runs (and the shadow records them)')

  if (mode === 'shadow') {
    // The CI run's reports: what each test did there, uninstrumented. A file
    // records only if it does the same here.
    // From this workflow run (the shadow job of your CI workflow), or from
    // the CI run that triggered this one (a workflow_run shadow).
    const client = new DefaultArtifactClient()
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
    const findBy = s.runId
      ? { token: core.getInput('token'), workflowRunId: s.runId, repositoryOwner: owner, repositoryName: repo }
      : undefined
    const { artifacts } = await client.listArtifacts({ latest: true, findBy })
    const mine = artifacts.filter((a) => a.name.startsWith('quod-vitest-reports-'))
    if (!mine.length) core.warning('Quod: the CI run left no test reports; nothing that runs here is recorded')
    for (const a of mine) await client.downloadArtifact(a.id, { path: paths.reports, findBy })
  }

  // The shim: a `node` first on PATH that runs the real one with hook.cjs
  // preloaded. Whatever starts vitest (npm scripts, npx, turbo, pnpm, a
  // `#!/usr/bin/env node` bin) finds node on PATH; GitHub refuses
  // NODE_OPTIONS from an action ($GITHUB_ENV), and turbo filters most
  // variables from its tasks, but every runner keeps PATH.
  const node = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
  if (!node) throw new Error('no node on PATH: put this step after actions/setup-node')
  // Quod Cloud, when this quod has it and the job may ask GitHub for an OIDC
  // token (`permissions: id-token: write`): quod then stores and finds the
  // ledger on the server (nearest recorded ancestor commit), and the cache
  // restored above stays the fallback. Otherwise the cache alone.
  let cloud = null
  if (core.getInput('cloud') !== 'false') {
    let help = ''
    try {
      help = execFileSync(quod, ['vitest', '--help'], { encoding: 'utf8' })
    } catch {}
    if (!help.includes('--cloud')) core.info('Quod: ledger hand-off through the Actions cache (this quod has no --cloud)')
    else if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
      core.info('Quod: ledger hand-off through the Actions cache (Quod Cloud needs `permissions: id-token: write`)')
    else {
      // quod --cloud starts from no ledger when the server cannot answer;
      // the cache's copy is kept for exactly that case.
      const server = core.getInput('server')
      let up = false
      try {
        up = (await fetch(`${server}/healthz`, { signal: AbortSignal.timeout(5000) })).ok
      } catch {}
      if (!up) core.warning(`Quod: ${server} did not answer; ledger hand-off through the Actions cache`)
      else {
        cloud = { QUOD_SERVER: server, QUOD_SERVER_KEY: core.getInput('server-key'), QUOD_JOB_ID: core.getInput('job-id') }
        core.info(`Quod: ledger hand-off through Quod Cloud (${server}); the Actions cache is the fallback`)
      }
    }
  }
  fs.copyFileSync(path.join(__dirname, '..', '..', 'hook.cjs'), paths.hook)
  fs.writeFileSync(
    paths.config,
    JSON.stringify({ quod, mode, ledgers: paths.ledgers, reports: paths.reports, root: process.env.GITHUB_WORKSPACE, cloud }),
  )
  const bin = path.join(paths.base, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh\n# Quod's node shim (pango07/quod-action): the real node, with the vitest shim preloaded.\n` +
      `[ "$QUOD_SHIM_ACTIVE" = 1 ] && exec ${q(node)} "$@"\n` +
      `exec ${q(node)} --require ${q(paths.hook)} "$@"\n`,
    { mode: 0o755 },
  )
  core.addPath(bin)
  core.saveState('active', '1')
}

run().catch((e) => core.warning(`Quod is off for this job (${e.message}); tests run as plain vitest`))
