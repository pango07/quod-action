'use strict'
// Three independent parts, each of which leaves the job as it was when it
// fails:
// - dependencies (deps.cjs): restores node_modules (npm) or the package
//   manager's store before your install step;
// - task cache: points turbo (and Nx) at Quod Cloud's remote cache, so a
//   task another job of this repository already ran replays;
// - vitest: installs quod, restores the most recent recording (the
//   ledger).
// Then the node shim on PATH (hook.cjs preloaded) for the rest of the job:
// it answers `npm ci` when node_modules is already its result, and runs
// one-shot vitest runs through quod.
const core = require('@actions/core')
const cache = require('@actions/cache')
const { DefaultArtifactClient } = require('@actions/artifact')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { paths, scope, keys } = require('./common')
const D = require('../deps.cjs')

// SHA-256 of each release's quod-linux-x86_64.tar.gz.
const PINS = {
  'bin-15cb5ab': 'eb75a5194e2cb97c443597299327b26bfe288b31730ff412b48237719d7d6db6',
  'bin-8aec5c5': '5af462b810d880c78af7b2619b885d34405b6b8c9eb8ad662615ff02690fc76c',
  'bin-ae52750': '9cbb48d36f41f79ee9d3470285c803dddba7651e3992f39687aa6838869bb41a',
  'bin-b9e34fc': 'caca43ddfeefd7bf05f771865ac69ac1b80a4bfad03bca7f667fa775400c2ac4',
  'bin-a026fea': 'f6594052a8ce0d61f915d019ba057be975475eba855a5c11fe5f664a72761fd8',
  'bin-34f932d': '9a1c2354cfdc5ab07b968e3a3a2929b58f9f6c34214ec2ad2876f225153032bc',
  'bin-8dc6916': 'ad5268aacd4fcd12a8760db8169fe82acb9cb7d2e8ffff538a67a58cb64b9e3f',
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
  'bin-d5fbfdc': 'ac4006cef111a3d09f3795a278b172b053daf4f11197feecb12f01278bbe26fb',
  'bin-d978cc4': '0287d29bdf41ecb1e96ebb710e2c98c4c964924d87ff62af5121f0e67086d6f1',
  'bin-0bb0c27': '54533fc3907868edd37c9c79ad15e2fa939449a09679332dee320069b4032259',
  'bin-c6f6ed3': 'a323c1204db58e8b32bef8801d1ea7dec5b791ebd6bff1fc4ffb772087267128',
  'bin-e3ece95': 'bf87ff357f389800d55fdee19503aaa0d3a076c7b898edf847f219912d475a6a',
  'bin-69ddad8': '0f6fe0c7010ca480e653c3f5975c896407af400dd42029fa033d6063b63a5d85',
  'bin-9e9d0b7': '48801e6b3c0e3672117f75ddf52984ff753624cec849d43c68a61a30533a2322',
  'bin-c0f55ad': '184442ceecb624e9c20300af2759fc4e178707e8a76de4ec9e969b9362118569',
}

// The release this action ships in dist/quod/<version>.tar.gz (the same
// file as the release asset, under the same SHA-256 pin): a job never
// fetches quod over the network when it asks for that version, so a
// release download's latency (5 s) and its failures (an HTTP 504 turned a
// bench job plain) are off the job's path.
function shipped(version, want) {
  try {
    // dist/main/index.js is what the runner started (argv[1]); a path the
    // bundler cannot follow, so it does not copy the file into the bundle.
    const here = path.dirname(process.argv[1] || __dirname)
    const body = fs.readFileSync(path.join(here, '..', 'quod', `${version}.tar.gz`))
    if (crypto.createHash('sha256').update(body).digest('hex') === want) return body
  } catch {}
  return null
}

async function install(version, want) {
  const dir = path.join(process.env.RUNNER_TOOL_CACHE || paths.base, 'quod', version)
  const bin = path.join(dir, 'quod')
  if (fs.existsSync(bin)) return bin
  let body = shipped(version, want)
  core.info(`quod ${version}: ${body ? 'shipped with this action' : 'not shipped with this action; downloading the release'}`)
  if (!body) {
    const url = `https://github.com/pango07/ci-bench/releases/download/${version}/quod-linux-x86_64.tar.gz`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    body = Buffer.from(await res.arrayBuffer())
    const got = crypto.createHash('sha256').update(body).digest('hex')
    if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`)
  }
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, 'quod.tar.gz')
  fs.writeFileSync(tgz, body)
  execFileSync('tar', ['-xzf', tgz, '-C', dir])
  fs.rmSync(tgz)
  return bin
}

// The node on PATH (setup-node's) and its npm: what your steps run.
function nodeFacts() {
  const node = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
  if (!node) throw new Error('no node on PATH: put this step after actions/setup-node')
  const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
  return { bin: node, node: version, npm: D.npmVersion(node) }
}

// Whether this job may save what it installed. The Actions cache scopes a
// save to the job's ref, but a pull_request_target or workflow_run job runs
// on the base branch's ref with someone else's code: what it saves, the
// base branch would restore. Only jobs on the repository's own code save
// (the server's rule for its writers and branch scopes).
function maySave() {
  const ev = process.env.GITHUB_EVENT_NAME
  if (!['push', 'pull_request', 'merge_group', 'workflow_dispatch', 'schedule'].includes(ev)) return false
  return ev !== 'pull_request' || scope().trusted
}

const home = () => process.env.HOME || require('node:os').homedir()

// Dependencies: what the project's package manager installs from,
// restored before your install step (deps.cjs has what is kept and why).
async function dependencies(facts) {
  if (core.getInput('dependencies') === 'false') return null
  const ws = process.env.GITHUB_WORKSPACE || process.cwd()
  const root = D.findRoot(ws)
  if (!root) {
    core.info('Quod dependencies: no lockfile found; nothing restored')
    return null
  }
  const info = D.detect(root)
  const t0 = Date.now()
  const key = D.key(root, info, facts)
  const os = `${process.platform}-${process.arch}`
  const st = { ws, root: fs.realpathSync(root), info, pm: info.pm, key, facts: { node: facts.node, npm: facts.npm }, hit: '', save: maySave() }
  if (info.pm === 'npm') {
    st.paths = D.npmPaths(ws, root)
    st.cacheKey = `quod-deps-npm-${os}-${key}`
    if (fs.existsSync(path.join(root, 'node_modules'))) {
      // Something else put node_modules there (another cache step): Quod
      // leaves it and its install alone.
      st.hit = 'preexisting'
      core.info('Quod dependencies: node_modules is already there (another step restored it); left as it is')
    } else {
      const hit = await cache.restoreCache(st.paths.slice(), st.cacheKey)
      st.hit = hit ? 'exact' : ''
      if (hit) st.print = D.treePrint(root)
      core.info(
        hit
          ? `Quod dependencies: node_modules restored for this lockfile (${key.slice(0, 12)}) in ${((Date.now() - t0) / 1000).toFixed(1)} s; \`npm ci\` will find it in place`
          : `Quod dependencies: no node_modules saved yet for this lockfile (${key.slice(0, 12)}); \`npm ci\` installs, and the tree is saved after the job`,
      )
      if (!hit) {
        // npm's download cache, when nothing restored one: the nearest
        // earlier lockfile's tarballs make `npm ci` mostly offline.
        const npmCache = path.join(home(), '.npm', '_cacache')
        if (!fs.existsSync(npmCache)) {
          const lockHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, info.lock))).digest('hex').slice(0, 40)
          st.npmCache = { path: npmCache, key: `quod-npmcache-${os}-${lockHash}` }
          const h2 = await cache.restoreCache([npmCache], st.npmCache.key, [`quod-npmcache-${os}-`])
          st.npmCache.hit = h2 === st.npmCache.key ? 'exact' : h2 ? 'prefix' : ''
          if (h2) core.info(`Quod dependencies: npm's download cache restored (${h2 === st.npmCache.key ? 'this lockfile' : 'an earlier lockfile'})`)
        }
      }
    }
  } else {
    // pnpm's store, yarn's and bun's caches: what the install fetches
    // from. The install verifies them and runs as always.
    let dir
    if (info.pm === 'pnpm') {
      try {
        dir = execFileSync('pnpm', ['store', 'path'], { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {
        dir = path.join(process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share'), 'pnpm', 'store')
      }
    } else if (info.pm === 'yarn-berry') {
      const rc = fs.existsSync(path.join(root, '.yarnrc.yml')) ? fs.readFileSync(path.join(root, '.yarnrc.yml'), 'utf8') : ''
      dir = /^\s*enableGlobalCache:\s*false/m.test(rc) ? path.join(root, '.yarn', 'cache') : path.join(home(), '.yarn', 'berry', 'cache')
    } else if (info.pm === 'yarn') {
      try {
        dir = execFileSync('yarn', ['cache', 'dir'], { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {
        dir = path.join(home(), '.cache', 'yarn')
      }
    } else {
      dir = path.join(process.env.BUN_INSTALL || path.join(home(), '.bun'), 'install', 'cache')
    }
    st.paths = [dir]
    st.cacheKey = `quod-deps-${info.pm}-${os}-${key}`
    let filled = false
    try {
      filled = fs.readdirSync(dir).length > 0
    } catch {}
    if (filled) {
      st.hit = 'preexisting'
      core.info(`Quod dependencies: ${dir} is already filled (another step restored it); left as it is`)
    } else {
      const hit = await cache.restoreCache(st.paths.slice(), st.cacheKey, [`quod-deps-${info.pm}-${os}-`])
      st.hit = hit === st.cacheKey ? 'exact' : hit ? 'prefix' : ''
      core.info(hit ? `Quod dependencies: ${info.pm}'s store restored (${st.hit === 'exact' ? 'this lockfile' : 'an earlier lockfile'}) in ${((Date.now() - t0) / 1000).toFixed(1)} s` : `Quod dependencies: no ${info.pm} store saved yet; saved after the job`)
    }
  }
  core.saveState('deps', JSON.stringify(st))
  return st
}

// The task cache: turbo's and Nx's remote cache pointed at Quod Cloud, for
// a session the job's OIDC token buys. Your own remote cache settings win.
async function taskCache(facts) {
  if (core.getInput('task-cache') === 'false') return
  const ws = process.env.GITHUB_WORKSPACE || process.cwd()
  const root = D.findRoot(ws) || ws
  const turbo = fs.existsSync(path.join(root, 'turbo.json')) || fs.existsSync(path.join(root, 'turbo.jsonc'))
  const nx = fs.existsSync(path.join(root, 'nx.json'))
  if (!turbo && !nx) return
  const env = process.env
  const useTurbo = turbo && !env.TURBO_API && !env.TURBO_TOKEN && !env.TURBO_TEAM && !env.TURBO_TEAMID
  const useNx = nx && !env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER && !env.NX_CLOUD_ACCESS_TOKEN && !env.NX_NO_CLOUD
  if (!useTurbo && !useNx) {
    core.info('Quod task cache: your own remote cache is configured; left as it is')
    return
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    core.info('Quod task cache: needs `permissions: id-token: write`; off')
    return
  }
  const server = core.getInput('server')
  const id = await core.getIDToken('quodci')
  const res = await fetch(`${server}/v1/task-cache/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'quod-protocol': 'quod.v1', authorization: `Bearer ${id}` },
    body: JSON.stringify({ env: { os: env.RUNNER_OS || process.platform, arch: env.RUNNER_ARCH || process.arch, node: facts.node, image: env.ImageOS || '' } }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${server}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const s = await res.json()
  core.setSecret(s.token)
  core.saveState('task-token', s.token)
  const where = s.write ? `writes ${s.write === 'trusted' ? 'the default branch' : 'this branch'}'s, reads ${s.read.length > 1 ? "it, then the default branch's" : 'it'}` : "reads the default branch's, writes none"
  if (useTurbo) {
    core.exportVariable('TURBO_API', server)
    core.exportVariable('TURBO_TOKEN', s.token)
    core.exportVariable('TURBO_TEAM', 'quod')
    core.info(`Quod task cache: turbo's remote cache is Quod Cloud (${where})`)
  }
  if (useNx) {
    core.exportVariable('NX_SELF_HOSTED_REMOTE_CACHE_SERVER', `${server}/nx`)
    core.exportVariable('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN', s.token)
    core.info(`Quod task cache: Nx's remote cache is Quod Cloud (${where})`)
  }
}

async function run() {
  const mode = core.getInput('mode') || 'check'
  core.saveState('mode', mode)
  if (process.env.QUOD_DISABLE === '1') {
    core.info('QUOD_DISABLE=1: Quod is off for this job')
    return
  }
  if (!['check', 'shadow'].includes(mode)) throw new Error(`mode must be check or shadow, not ${mode}`)
  if (process.platform === 'win32') {
    core.warning('Quod runs on Linux and macOS runners so far; off for this job')
    return
  }
  // Per-repository policies for quod vitest (off by default).
  // timing-sensitive: replay: a file whose plain runs came near a test's
  // timeout replays once two plain runs of its unchanged inputs passed,
  // labelled with its margin. timing-audit: N: every Nth such replay runs
  // the file plain instead; a timeout there quarantines it.
  if (core.getInput('timing-sensitive') === 'replay') core.exportVariable('QUOD_VITEST_TIMING', 'replay')
  core.exportVariable('QUOD_VITEST_LINEAGE', core.getInput('lineage-witness') === 'true' ? '1' : '0')
  const audit = core.getInput('timing-audit')
  if (/^[1-9][0-9]*$/.test(audit)) core.exportVariable('QUOD_VITEST_TIMING_AUDIT', audit)
  const facts = nodeFacts()
  fs.mkdirSync(paths.base, { recursive: true })
  // The three parts are independent (each its own cache entries and
  // files): they run at once, so main costs the slowest of them, not
  // their sum (node_modules' restore, ~3 s for convex-helpers, hides the
  // quod install and the ledger's).
  const t0 = Date.now()
  const depsP = dependencies(facts).catch((e) => {
    core.warning(`Quod dependencies are off for this job (${e.message}); your install runs as always`)
    return null
  })
  // GitHub's OIDC endpoint retries for minutes when it is slow; the task
  // cache is never worth that. Past the deadline, tasks run as always.
  let timer
  const taskP = Promise.race([
    taskCache(facts),
    new Promise((_, no) => {
      timer = setTimeout(() => no(new Error('no OIDC token or session within 10 s')), 10000)
    }),
  ])
    .finally(() => clearTimeout(timer))
    .catch((e) => core.warning(`Quod task cache is off for this job (${e.message}); tasks run as always`))
  const testsP = vitest(mode).catch((e) => {
    core.warning(`Quod is off for vitest in this job (${e.message}); tests run as plain vitest`)
    return false
  })
  const [deps, , tests] = await Promise.all([depsP, taskP, testsP])
  // For the post step: whether quod ran this job's vitest (and units).
  core.saveState('vitest', tests ? '1' : '')
  core.info(`Quod: ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  if (!deps && !tests) return
  // The shim: a `node` first on PATH that runs the real one with hook.cjs
  // preloaded. Whatever starts vitest or npm (npm scripts, npx, turbo,
  // pnpm, a `#!/usr/bin/env node` bin) finds node on PATH; GitHub refuses
  // NODE_OPTIONS from an action ($GITHUB_ENV), and turbo filters most
  // variables from its tasks, but every runner keeps PATH.
  fs.copyFileSync(path.join(__dirname, '..', '..', 'hook.cjs'), paths.hook)
  fs.copyFileSync(path.join(__dirname, '..', '..', 'deps.cjs'), path.join(paths.base, 'deps.cjs'))
  if (deps) fs.writeFileSync(path.join(paths.base, 'deps.json'), JSON.stringify(deps))
  const bin = path.join(paths.base, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh\n# Quod's node shim (pango07/quod-action): the real node, with hook.cjs preloaded.\n` +
      `[ "$QUOD_SHIM_ACTIVE" = 1 ] && exec ${q(facts.bin)} "$@"\n` +
      `exec ${q(facts.bin)} --require ${q(paths.hook)} "$@"\n`,
    { mode: 0o755 },
  )
  core.addPath(bin)
  core.saveState('active', '1')
}

// vitest: quod installed, the ledger restored, the hook's config written.
// True when vitest goes through quod in this job.
async function vitest(mode) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    core.info(`Quod's vitest replay runs on Linux x64 runners so far (this is ${process.platform}-${process.arch}); tests run as plain vitest`)
    return false
  }
  const s = scope()
  if (mode === 'shadow' && !s.trusted) {
    // A fork's code must not write a ledger every branch reads.
    core.notice('Quod: not recording a fork pull request (its code is not trusted to write the ledger)')
    return false
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
          // Quod Cloud giving this job no ledger (down, 403, none yet) keeps
          // the local one: the Actions cache's copy (scoped by GitHub as
          // before Quod Cloud) or this job's own earlier recording, so the
          // second witness can follow within and across jobs.
          QUOD_VITEST_CLOUD_FALLBACK: '1',
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
  fs.writeFileSync(
    paths.config,
    JSON.stringify({ quod, mode, record, ledgers: paths.ledgers, reports: paths.reports, root: process.env.GITHUB_WORKSPACE, cloud, prefetch }),
    { mode: 0o600 },
  )
  return true
}

run()
  .catch((e) => core.warning(`Quod is off for this job (${e.message})`))
  // Whatever is still pending (a token request past its deadline) does not
  // hold the step: everything this step does is done.
  .finally(() => process.exit(0))
