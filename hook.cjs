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
  if (bin && /npm(-cli\.js)?$/.test(bin)) {
    const a = argv.slice(2)
    if (['run', 'run-script', 'rum', 'urn'].includes(a[0])) return npmUnit(bin, a)
    return npmCi(bin, a)
  }
  if (bin && /yarn/.test(bin)) return yarnNode(bin)
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
  // (snapshot updates, the UI, browser mode, shards, changed-file filters)
  // stay plain vitest. Coverage (`--coverage`, or enabled in the config)
  // goes through quod: a replayed file's recorded coverage joins the report
  // (quod runs every file itself when it cannot carry the provider).
  let args = argv.slice(2)
  if (args[0] === 'run') args = args.slice(1)
  else if (!env.CI || ['watch', 'dev', 'related', 'bench', 'typecheck', 'list', 'init'].includes(args[0])) return
  const plain = /^(-w|--watch|--ui|--browser|-u|--update|--merge-reports|--shard|--changed|--standalone|--inspect|--inspect-brk|--typecheck)(\.|=|$)/
  if (args.some((a) => plain.test(a))) return

  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  } catch {
    return
  }

  // What quod cannot record runs as plain vitest, untouched (no quod process
  // at all): yarn Plug'n'Play (vitest and the dependencies in zip archives),
  // and vitest outside the implemented 3.2/4/5 compatibility paths. Future
  // major versions must pass their own gate before interception. The shadow
  // job runs vitest only to record, so there it does not run at all.
  let version = ''
  try {
    version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version ?? ''
  } catch {}
  const release = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  const major = Number(release?.[1]), minor = Number(release?.[2])
  const no = process.versions.pnp
    ? "yarn Plug'n'Play is not supported yet"
    : !((major === 3 && minor >= 2) || major === 4 || major === 5)
      ? `vitest ${version || '(unknown version)'} is not supported (3.2.x–3.x, 4.x or 5.x)`
      : ''
  if (no) {
    if (cfg.mode === 'shadow') {
      console.error(`quod: ${no}; nothing to record, so the shadow skips this vitest run`)
      process.exit(0)
    }
    console.error(`quod: ${no}; running plain vitest`)
    return
  }

  if (cfg.managed && cfg.mode === 'check') {
    // This first profile resolves the repository-root invocation only. A
    // package-local Vitest command keeps its original cwd and native selection.
    if (fs.realpathSync(process.cwd()) !== fs.realpathSync(cfg.root)) return
    const child = require('node:child_process').spawnSync(process.execPath,
      [cfg.managed.bridge, path.join(__dirname, 'config.json'), entry, ...argv.slice(2)],
      {stdio: 'inherit', env: {...env, QUOD_SHIM_ACTIVE: '1'}})
    if (child.error) {
      console.error(`quod managed: could not start (${child.error.message}); running ordinary Vitest`)
      return
    }
    process.exit(child.status ?? 1)
  }

  if (typeof cfg.quod !== 'string' || !fs.existsSync(cfg.quod)) return

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
  // The matching post bundle waits for these saves alongside the cache
  // saves. Old configs keep the original inline-save behavior.
  let deferredCloud = !!cfg.cloud && cfg.deferCloudSave === true && (cfg.record || cfg.mode === 'shadow')
  // Which suite each ledger directory is (travels with the cache's copy):
  // the next job's background restore names the suites by it.
  try {
    const names = path.join(cfg.ledgers, '.suites')
    fs.mkdirSync(names, { recursive: true })
    fs.writeFileSync(path.join(names, id), suite)
  } catch { deferredCloud = false }
  if (deferredCloud) cloud.push('--cloud-no-save')
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
  // check (records inline unless read only), or the older shadow.
  const q =
    cfg.mode === 'shadow'
      ? ['vitest', '--dir', dir, ...cloud, '--audits', '4', '--expect-report', report, '--', 'run', ...args]
      : cfg.record
        ? ['vitest', '--dir', dir, ...cloud, '--report', report, '--summary', `${report}.summary`, '--', 'run', ...args]
        : ['vitest', '--no-record', '--dir', dir, ...cloud, '--report', report, '--', 'run', ...args]
  const r = require('node:child_process').spawnSync(cfg.quod, q, {
    stdio: 'inherit',
    env: { ...env, ...(cfg.cloud ?? {}), QUOD_SHIM_ACTIVE: '1' },
  })
  if (r.error) {
    console.error(`quod: could not start (${r.error.message}); running vitest itself`)
    return
  }
  // Whether this run recorded anything (a full replay emitted records
  // nothing): the post step saves the ledger only if one did.
  let changed = cfg.mode === 'shadow'
  if (cfg.record && cfg.mode !== 'shadow') {
    let fast = false
    try {
      fast = JSON.parse(fs.readFileSync(`${report}.summary`, 'utf8')).fast === true
    } catch {}
    if (!fast) {
      changed = true
      try {
        fs.writeFileSync(path.join(__dirname, 'recorded'), '')
      } catch {}
    }
  }
  if (deferredCloud && changed) {
    try {
      const dirty = path.join(__dirname, 'cloud-recorded')
      fs.mkdirSync(dirty, { recursive: true })
      fs.writeFileSync(path.join(dirty, id), '')
    } catch {
      // Losing the post marker must not lose the original save attempt.
      console.error('quod: could not queue the Cloud ledger save; saving it now')
      require('node:child_process').spawnSync(cfg.quod,
        ['vitest', '--dir', dir, '--cloud', '--suite', suite, '--cloud-only', 'save'],
        { stdio: 'inherit', env: { ...env, ...cfg.cloud, QUOD_SHIM_ACTIVE: '1' } })
    }
  }
  // The recording run is diagnostics only: it never fails the command (so a
  // task runner goes on to record every package).
  if (cfg.mode === 'shadow') process.exit(0)
  process.exit(r.status ?? 1)
})()

// Yarn (classic and berry, directly, through corepack, or a yarnPath
// release) runs package scripts and bins with a `node` of its own first on
// PATH: a wrapper in a temporary directory (/tmp/yarn--*, /tmp/xfs-*) that
// runs yarn's own process.execPath, the real node, which is the shim's
// target, not the shim. So the hook would never load under `yarn test`. In
// yarn's process (the shim started it), process.execPath becomes the shim,
// which yarn's wrappers then run: the real node with this file preloaded,
// exactly as everywhere else. Nothing else in yarn changes; a node it
// forks or spawns by execPath gets the shim, which is node.
function yarnNode(bin) {
  const fs = require('node:fs')
  const path = require('node:path')
  let entry
  try {
    entry = fs.realpathSync(bin)
  } catch {
    return
  }
  // yarn classic's bin/yarn.js, corepack's yarn.js and yarnpkg.js, berry's
  // .yarn/releases/yarn-<version>.cjs and its corepack copy (yarn.js).
  if (!/^yarn(pkg)?(-[^/]*)?\.c?js$/.test(path.basename(entry))) return
  const shim = path.join(__dirname, 'bin', 'node')
  try {
    fs.accessSync(shim, fs.constants.X_OK)
    process.execPath = shim
  } catch {}
}

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
    now = D.key(st.root, st.info, { node: process.version, npm, bin: process.execPath }, process.env, st.installProfile)
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
      // The key leaves the project's own version out (a release bump
      // installs the same tree); npm writes it only into the hidden
      // lockfile's header, brought up to date here as npm ci would.
      try {
        const hidden = path.join(st.root, 'node_modules', '.package-lock.json')
        const h = JSON.parse(fs.readFileSync(hidden, 'utf8'))
        const v = JSON.parse(fs.readFileSync(path.join(st.root, 'package.json'), 'utf8')).version
        if (h.version !== v) {
          if (v === undefined) delete h.version
          else h.version = v
          fs.writeFileSync(hidden, `${JSON.stringify(h, null, 2)}\n`)
        }
      } catch {}
      console.log(`quod: node_modules is what \`npm ci\` installs here (restored for this lockfile, package.json files, node ${process.version} and npm ${marker.npm ?? ''}); npm ci skipped`)
      process.exit(0)
    }
    if (!same) console.log('quod: the restored node_modules was installed another way; npm ci runs')
    else console.log('quod: node_modules changed after Quod restored it; npm ci runs')
  }
  process.on('exit', (code) => {
    if (code !== 0) return
    try {
      // Put the marker down now, before any build lists node_modules.
      // Fresh installs and restored trees must expose the same filenames.
      fs.writeFileSync(path.join(st.root, 'node_modules', '.quod-deps.json'), JSON.stringify({ key: now, args: want, npm: st.facts.npm }))
      fs.writeFileSync(record, JSON.stringify({ key: now, args: want, print: D.fullPrint(st.ws, st.paths) }))
    } catch {}
  })
}

// `npm run <script>` whose script (with its pre/post scripts and the
// scripts it runs with `npm run`) runs no vitest: a unit (quod unit,
// docs/through-the-wall.md B1). Quod answers it from its record when every
// input it read is unchanged (output printed, files restored, exit code),
// else runs it: traced in a sandbox the first time, plain the second, to
// record it. vitest has its own recorder, so a script that runs vitest stays
// npm's, and the vitest in it goes through the shim as always.
// QUOD_UNITS=0 turns units off.
function npmUnit(bin, args) {
  const env = process.env
  if (env.QUOD_UNITS === '0') return
  const fs = require('node:fs')
  const path = require('node:path')
  let entry
  try {
    entry = fs.realpathSync(bin)
  } catch {
    return
  }
  if (!entry.endsWith(`${path.sep}npm${path.sep}bin${path.sep}npm-cli.js`)) return
  // Only `npm run <script> [-- args]`: no workspaces, no flags.
  const script = args[1]
  if (!script || script.startsWith('-')) return
  if (args.length > 2 && args[2] !== '--') return
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  } catch {
    return
  }
  if (cfg.mode === 'shadow' || !cfg.root || typeof cfg.quod !== 'string' || !fs.existsSync(cfg.quod)) return
  const cwd = process.cwd()
  const root = cfg.root
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return
  // npm's prefix: the nearest package.json up from here.
  let dir = cwd
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir)
    if (up === dir) return
    dir = up
  }
  let scripts
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}
  } catch {
    return
  }
  if (typeof scripts[script] !== 'string') return
  const seen = new Set()
  const todo = [script]
  while (todo.length) {
    const s = todo.pop()
    for (const n of [s, `pre${s}`, `post${s}`]) {
      if (seen.has(n) || typeof scripts[n] !== 'string') continue
      seen.add(n)
      const text = scripts[n]
      if (/\bvitest\b/.test(text)) return
      for (const m of text.matchAll(/\bnpm\s+(?:run(?:-script)?\s+|test\b|t\b)([^\s&|;]*)/g)) todo.push(m[1] || 'test')
    }
  }
  const q = ['unit', '--dir', path.join(cfg.ledgers, 'units'), '--root', root, '--mark', path.join(__dirname, 'recorded')]
  if (!cfg.record) q.push('--no-record')
  q.push('--', process.execPath, entry, ...args)
  const r = require('node:child_process').spawnSync(cfg.quod, q, {
    stdio: 'inherit',
    env: { ...env, QUOD_SHIM_ACTIVE: '1' },
  })
  if (r.error) {
    console.error(`quod: could not start (${r.error.message}); npm runs the script itself`)
    return
  }
  process.exit(r.status ?? 1)
}
