'use strict'
// Quod's vitest shim (pango07/quod-action). The action's `node` shim, first
// on PATH, preloads it (`--require`) into every node process of the job; it
// does nothing unless the process is vitest's own command line (whatever
// started it: a package script, npx, turbo, node_modules/.bin) doing a
// one-shot run. Then it runs `quod vitest` with the same arguments instead
// and exits with its code: the same output, reports and exit code as
// vitest, with unchanged test files replayed.
//
// Never loops: quod and everything it starts get QUOD_SHIM_ACTIVE=1, which
// makes the node shim run node without this file. Falls back to plain
// vitest whenever it cannot run quod (QUOD_DISABLE=1, no config, quod
// missing).
;(() => {
  const argv = process.argv
  const env = process.env
  if (env.QUOD_SHIM_ACTIVE === '1' || env.QUOD_DISABLE === '1') return
  const bin = argv[1]
  if (bin && /npm(-cli\.js)?$/.test(bin)) return npmCi(bin, argv.slice(2))
  if (!bin || !/vitest(\.m?js)?$/.test(bin)) return
  const fs = require('node:fs')
  const path = require('node:path')
  let entry
  try {
    entry = fs.realpathSync(bin)
  } catch {
    return
  }
  if (!entry.endsWith(`${path.sep}node_modules${path.sep}vitest${path.sep}vitest.mjs`)) return

  // One-shot runs only: `vitest run ...`, or `vitest ...` where vitest runs
  // once (CI). Watch mode, other commands and what quod cannot replay
  // (coverage reports, snapshot updates, the UI, browser mode, shards,
  // changed-file filters) stay plain vitest.
  let args = argv.slice(2)
  if (args[0] === 'run') args = args.slice(1)
  else if (!env.CI || ['watch', 'dev', 'related', 'bench', 'typecheck', 'list', 'init'].includes(args[0])) return
  const plain = /^(-w|--watch|--ui|--browser|-u|--update|--coverage|--merge-reports|--shard|--changed|--standalone|--inspect|--inspect-brk|--typecheck)(\.|=|$)/
  if (args.some((a) => plain.test(a))) return

  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  } catch {
    return
  }
  if (!fs.existsSync(cfg.quod)) return

  // One ledger per package and command line: where it runs (from the
  // repository root) and its arguments.
  const crypto = require('node:crypto')
  const rel = path.relative(cfg.root, process.cwd()) || 'root'
  const id = `${rel.replace(/[^A-Za-z0-9._-]+/g, '_')}-${crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)}`
  const dir = path.join(cfg.ledgers, id)
  const report = path.join(cfg.reports, `${id}.json`)
  fs.mkdirSync(cfg.reports, { recursive: true })
  // With Quod Cloud the ledger is the suite's on the server (the cache's
  // copy in `dir` is the fallback); its variables are quod's, not the tests'.
  // The suite's name in Quod Cloud is what people see: the package's
  // directory from the repository root, plus the arguments when there are
  // any (the same package run two ways is two suites).
  const where = rel === 'root' ? '.' : rel
  const suite = args.length ? `${where} ${args.join(' ')}` : where
  const cloud = cfg.cloud ? ['--cloud', '--suite', suite] : []
  // Which suite each ledger directory is (travels with the cache's copy):
  // the next job's background restore names the suites by it.
  try {
    const names = path.join(cfg.ledgers, '.suites')
    fs.mkdirSync(names, { recursive: true })
    fs.writeFileSync(path.join(names, id), suite)
  } catch {}
  // The action started this suite's restore in the background: wait for it
  // (quod then uses what it restored), at most 2 minutes; then stop it, so
  // quod's own restore never shares the directory with it.
  const state = cfg.cloud && cfg.prefetch ? path.join(cfg.prefetch, id) : null
  if (state && fs.existsSync(state)) {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const t0 = Date.now()
    let s = ''
    for (;;) {
      try {
        s = fs.readFileSync(state, 'utf8')
      } catch {
        break
      }
      if (!s.startsWith('running')) break
      if (Date.now() - t0 > 120000) {
        try {
          process.kill(-Number(s.split(' ')[1]), 'SIGKILL')
        } catch {}
        console.error('quod: the background restore took over 2 minutes; restoring here')
        break
      }
      Atomics.wait(pause, 0, 0, 200)
    }
  }
  const q =
    cfg.mode === 'shadow'
      ? ['vitest', '--dir', dir, ...cloud, '--audits', '4', '--expect-report', report, '--', 'run', ...args]
      : ['vitest', '--no-record', '--dir', dir, ...cloud, '--report', report, '--', 'run', ...args]
  const r = require('node:child_process').spawnSync(cfg.quod, q, {
    stdio: 'inherit',
    env: { ...env, ...(cfg.cloud ?? {}), QUOD_SHIM_ACTIVE: '1' },
  })
  if (r.error) {
    console.error(`quod: could not start (${r.error.message}); running vitest itself`)
    return
  }
  // The recording run is diagnostics only: it never fails the command (so a
  // task runner goes on to record every package).
  if (cfg.mode === 'shadow') process.exit(0)
  process.exit(r.status ?? 1)
})()

// `npm ci` in the project Quod restored node_modules for (deps.cjs). npm ci
// deletes node_modules and installs the lockfile; when the tree on disk is
// already what an earlier `npm ci` installed from the same key (the
// lockfile, every package.json, .npmrc, node, npm, OS, arch, image and npm's
// environment), with the same arguments, and nothing has touched it since
// Quod restored it, this answers for npm: exit 0, nothing changed.
// Otherwise npm runs as always, and a successful install is noted for the
// post step, which saves the tree when nothing outside the key can have
// gone into it.
function npmCi(bin, args) {
  const fs = require('node:fs')
  const path = require('node:path')
  let entry
  try {
    entry = fs.realpathSync(bin)
  } catch {
    return
  }
  if (!entry.endsWith(`${path.sep}npm${path.sep}bin${path.sep}npm-cli.js`)) return
  let D, st
  try {
    D = require(path.join(__dirname, 'deps.cjs'))
    if (!D.NPM_CI.includes(args[0])) return
    st = JSON.parse(fs.readFileSync(path.join(__dirname, 'deps.json'), 'utf8'))
    if (st.pm !== 'npm' || fs.realpathSync(process.cwd()) !== st.root) return
  } catch {
    return
  }
  // Whatever an earlier `npm ci` of this job left, this one decides.
  const record = path.join(__dirname, 'deps-installed.json')
  try {
    fs.rmSync(record, { force: true })
  } catch {}
  const want = D.npmArgs(args.slice(1))
  let now
  try {
    const npm = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version
    now = D.key(st.root, st.info, { node: process.version, npm, bin: process.execPath })
  } catch {
    return
  }
  if (st.hit === 'exact' && now === st.key) {
    let marker = null
    try {
      marker = JSON.parse(fs.readFileSync(path.join(st.root, 'node_modules', '.quod-deps.json'), 'utf8'))
    } catch {}
    const same = marker && marker.key === now && JSON.stringify(marker.args) === JSON.stringify(want)
    if (same && D.treePrint(st.root) === st.print) {
      console.log(`quod: node_modules is what \`npm ci\` installs here (restored for this lockfile, package.json files, node ${process.version} and npm ${marker.npm ?? ''}); npm ci skipped`)
      process.exit(0)
    }
    if (!same) console.log('quod: the restored node_modules was installed another way; npm ci runs')
    else console.log('quod: node_modules changed after Quod restored it; npm ci runs')
  }
  process.on('exit', (code) => {
    if (code !== 0) return
    try {
      fs.writeFileSync(record, JSON.stringify({ key: now, args: want, print: D.fullPrint(st.ws, st.paths) }))
    } catch {}
  })
}
