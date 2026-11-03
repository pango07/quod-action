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
  const q =
    cfg.mode === 'shadow'
      ? ['vitest', '--dir', dir, '--audits', '4', '--expect-report', report, '--', 'run', ...args]
      : ['vitest', '--no-record', '--dir', dir, '--report', report, '--', 'run', ...args]
  const r = require('node:child_process').spawnSync(cfg.quod, q, { stdio: 'inherit', env: { ...env, QUOD_SHIM_ACTIVE: '1' } })
  if (r.error) {
    console.error(`quod: could not start (${r.error.message}); running vitest itself`)
    return
  }
  // The recording run is diagnostics only: it never fails the command (so a
  // task runner goes on to record every package).
  if (cfg.mode === 'shadow') process.exit(0)
  process.exit(r.status ?? 1)
})()
