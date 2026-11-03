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
const { execFileSync, spawn } = require('node:child_process')
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
  'bin-1dd00b0': '12c1abb1ef7ab11ec333a7e9cb0ced784b124549bc8c296ef1fa17bf2e74ebcd',
  'bin-d242bd2': '8cb00dea7c3b0b9f369cdfe15579c6cd61a917ee0e471460153111fac6cce394',
  'bin-48fec94': 'c22bffd824687790e12dc157249a080850dd9608c54b489be6ed67c7443dbd4d',
  'bin-3115603': '2c2dcf119575c5393080fbab8df1ba6f9b4cac54b52b77acacd2ecf959fc456f',
  'bin-48c22e3': '604d6c2237faa04bae0f232966b535394bbd1778e49cbda946c7d5d76a02d6a4',
  'bin-d40c669': '398053199c63a76c4e35a47b43e13e59465e43311f497e84f4fb74a2ad329ac7',
  'bin-c8a44d5': '1d30557dcab7e6118035e0f1b9076bde298b654376034af0c5b532b26eab67aa',
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
  // The check job records as it runs (its records replay once a second run
  // agrees), unless it is a fork's pull request (read only: a fork's code
  // never writes a ledger) or `record: false` (a setup with the shadow job).
  const record = mode === 'check' && core.getInput('record') !== 'false' && s.trusted
  if (mode === 'check' && !s.trusted) core.info('Quod: a fork pull request: replays only, records nothing')
  core.saveState('record', record ? '1' : '')
  fs.mkdirSync(paths.ledgers, { recursive: true })
  fs.mkdirSync(paths.reports, { recursive: true })
  let version = core.getInput('version')
  let want = core.getInput('sha256') || PINS[version]
  if (mode === 'shadow') {
    // The CI run's reports: what each test did there, uninstrumented. A file
    // records only if it does the same here. From this workflow run (the
    // shadow job of your CI workflow), or from the CI run that triggered
    // this one (a workflow_run shadow).
    const client = new DefaultArtifactClient()
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
    const findBy = s.runId
      ? { token: core.getInput('token'), workflowRunId: s.runId, repositoryOwner: owner, repositoryName: repo }
      : undefined
    const { artifacts } = await client.listArtifacts({ latest: true, findBy })
    const mine = artifacts.filter((a) => a.name.startsWith('quod-vitest-reports-'))
    if (!mine.length) core.warning('Quod: the CI run left no test reports; nothing that runs here is recorded')
    for (const a of mine) await client.downloadArtifact(a.id, { path: paths.reports, findBy })
    // Record with the quod the test job ran. The `uses:` inside the shadow
    // workflow cannot follow the caller's pin, so this action's own version
    // may be another; a recording pairs only with a critical path of the
    // same quod.
    try {
      const used = JSON.parse(fs.readFileSync(path.join(paths.reports, 'quod.json'), 'utf8'))
      if (used.version && /^[0-9a-f]{64}$/.test(used.sha256 ?? '')) {
        if (used.version !== version) core.info(`Quod: recording with ${used.version}, the quod your test job ran`)
        version = used.version
        want = used.sha256
      }
    } catch {}
  }
  if (!want) throw new Error(`no sha256 for ${version}: set the sha256 input`)
  const quod = await install(version, want)
  core.info(`quod ${version} at ${quod}`)
  core.saveState('version', JSON.stringify({ version, sha256: want }))

  const k = keys(s)
  core.saveState('key', k.key)
  const hit = await cache.restoreCache([paths.ledgers], k.key, k.restore)
  core.saveState('hit', hit === k.key ? 'exact' : hit ? 'prefix' : '')
  core.info(hit ? `Quod: the recording ${hit}` : `Quod: no recording yet; every test file runs${record ? ' and records' : ''}`)

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
        // GitHub's OIDC request variables go to quod through the config file
        // (0600, in the runner's temp): task runners filter them from their
        // tasks (turbo's strict env mode drops ACTIONS_*), and quod needs
        // them to restore, report and save.
        cloud = {
          QUOD_SERVER: server,
          QUOD_SERVER_KEY: core.getInput('server-key'),
          QUOD_JOB_ID: core.getInput('job-id'),
          ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
        core.info(`Quod: ledger hand-off through Quod Cloud (${server}); the Actions cache is the fallback`)
      }
    }
  }
  // Restore from Quod Cloud now, in the background, while your install
  // runs: one detached `quod vitest --cloud-only restore` per suite this
  // repository's last recording had (the suites in the cache's copy). quod
  // leaves a marker for this job; the test step's `quod vitest --cloud`
  // then uses that ledger instead of fetching it again. The hook waits for
  // a restore still running (up to 2 minutes, then stops it and fetches
  // itself); a failed one just means the test step fetches, or every file
  // runs. A test step that never runs leaves it to the job's cleanup.
  const prefetch = path.join(paths.base, 'prefetch')
  if (cloud) {
    fs.mkdirSync(prefetch, { recursive: true })
    // Each ledger directory's suite name, as the hook wrote it (an older
    // copy without names is not prefetched: the test step restores it).
    const names = path.join(paths.ledgers, '.suites')
    const suites = fs
      .readdirSync(paths.ledgers, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        try {
          return { id: d.name, suite: fs.readFileSync(path.join(names, d.name), 'utf8') }
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const log = fs.openSync(path.join(prefetch, 'restore.log'), 'a')
    for (const d of suites) {
      const state = path.join(prefetch, d.id)
      const child = spawn(
        'sh',
        ['-c', '"$0" vitest --dir "$1" --cloud --suite "$2" --cloud-only restore; echo "done $?" > "$3"', quod, path.join(paths.ledgers, d.id), d.suite, state],
        { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...cloud }, cwd: process.env.GITHUB_WORKSPACE },
      )
      fs.writeFileSync(state, `running ${child.pid}`)
      child.unref()
    }
    if (suites.length) core.info(`Quod: restoring ${suites.length} suites from Quod Cloud in the background`)
  }
  fs.copyFileSync(path.join(__dirname, '..', '..', 'hook.cjs'), paths.hook)
  fs.writeFileSync(
    paths.config,
    JSON.stringify({ quod, mode, record, ledgers: paths.ledgers, reports: paths.reports, root: process.env.GITHUB_WORKSPACE, cloud, prefetch }),
    { mode: 0o600 },
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
