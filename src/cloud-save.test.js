'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { saveCloudLedgers } = require('./cloud-save')
const { saveTogether } = require('./saves')
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')

function fixture(t, extra = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quod-cloud-post-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project with spaces'), pkg = path.join(root, 'node_modules/vitest')
  const bin = path.join(pkg, 'vitest.mjs'), quod = path.join(base, 'quod')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(bin, '')
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"5.0.0"}')
  fs.writeFileSync(quod, '')
  const cfg = { root, quod, ledgers: path.join(base, 'ledgers'), reports: path.join(base, 'reports'),
    mode: 'check', record: true, cloud: {}, deferCloudSave: true, ...extra }
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(cfg))
  const calls = [], messages = []
  function invoke({ fast = false, code = 0, value = 'record', error = false } = {}) {
    let exited
    const stopped = {}
    try { vm.runInNewContext(hook, { __dirname: base, console: { error: m => messages.push(m) },
      require: n => n === 'node:child_process' ? { spawnSync: (command, args, options) => {
        calls.push({ command, args: Array.from(args), options })
        if (error) return { error: new Error('spawn failed') }
        if (!args.includes('--cloud-only')) {
          const dir = args[args.indexOf('--dir') + 1]
          fs.mkdirSync(dir, { recursive: true })
          if (!fast) fs.writeFileSync(path.join(dir, 'ledger.json'), value)
          if (args.includes('--summary')) fs.writeFileSync(args[args.indexOf('--summary') + 1], JSON.stringify({ fast }))
        }
        return { status: code }
      } } : require(n),
      process: { argv: [process.execPath, bin, 'run'], env: { CI: '1' }, versions: {}, cwd: () => root,
        exit: code => { exited = code; throw stopped } } })
    } catch (e) { if (e !== stopped) throw e }
    return exited
  }
  return { base, cfg, calls, messages, invoke }
}

test('multiple recordings queue one final ledger; a later hit does not erase it', async t => {
  const f = fixture(t)
  assert.equal(f.invoke({ value: 'first' }), 0)
  assert.equal(f.invoke({ value: 'final' }), 0)
  assert.equal(f.invoke({ fast: true }), 0)
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(c => c.args.includes('--cloud-no-save')))
  assert.ok(f.calls.every(c => c.args.includes('--report')))
  const seen = []
  assert.equal(await saveCloudLedgers(f.base, async (cfg, dir, suite) => {
    seen.push({ suite, value: fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8') })
  }), 1)
  assert.deepEqual(seen, [{ suite: '.', value: 'final' }])
  assert.equal(await saveCloudLedgers(f.base, () => assert.fail('save already completed')), 0)
})

test('full hits, read-only runs and old configs do not queue redundant Cloud saves', async t => {
  for (const extra of [{}, { record: false }, { deferCloudSave: false }, { cloud: null }]) {
    const f = fixture(t, extra)
    f.invoke({ fast: true })
    assert.equal(await saveCloudLedgers(f.base, () => assert.fail('nothing recorded')), 0)
    assert.equal(f.calls[0].args.includes('--cloud-no-save'), !('record' in extra || 'deferCloudSave' in extra || 'cloud' in extra))
  }
})

test('failed tests retain their exit code and still queue changed quarantine state', async t => {
  const f = fixture(t)
  assert.equal(f.invoke({ code: 2, value: 'quarantined' }), 2)
  assert.equal(await saveCloudLedgers(f.base, async (_, dir) => {
    assert.equal(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), 'quarantined')
  }), 1)
  const failed = fixture(t)
  assert.equal(failed.invoke({ error: true }), undefined)
  assert.equal(await saveCloudLedgers(failed.base, () => assert.fail('no recording process started')), 0)
})

test('shadow recordings defer their save while keeping diagnostic exit behavior', async t => {
  const f = fixture(t, { mode: 'shadow' })
  assert.equal(f.invoke({ code: 2 }), 0)
  assert.ok(f.calls[0].args.includes('--expect-report'))
  assert.ok(f.calls[0].args.includes('--cloud-no-save'))
  assert.equal(await saveCloudLedgers(f.base, async () => {}), 1)
})

test('missing queue metadata preserves an inline save attempt', t => {
  const marker = fixture(t)
  fs.writeFileSync(path.join(marker.base, 'cloud-recorded'), 'not a directory')
  assert.equal(marker.invoke({ code: 2 }), 2)
  assert.equal(marker.calls.length, 2)
  assert.ok(marker.calls[0].args.includes('--cloud-no-save'))
  assert.ok(marker.calls[1].args.includes('--cloud-only'))
  assert.ok(!marker.calls[1].args.includes('--cloud-no-save'))
  const names = fixture(t)
  fs.mkdirSync(names.cfg.ledgers)
  fs.writeFileSync(path.join(names.cfg.ledgers, '.suites'), 'not a directory')
  names.invoke()
  assert.equal(names.calls.length, 1)
  assert.ok(!names.calls[0].args.includes('--cloud-no-save'))
})

function addSuite(f, id, suite = id) {
  fs.mkdirSync(path.join(f.cfg.ledgers, id), { recursive: true })
  fs.mkdirSync(path.join(f.cfg.ledgers, '.suites'), { recursive: true })
  fs.mkdirSync(path.join(f.base, 'cloud-recorded'), { recursive: true })
  fs.writeFileSync(path.join(f.cfg.ledgers, id, 'ledger.json'), '{}')
  fs.writeFileSync(path.join(f.cfg.ledgers, '.suites', id), suite)
  fs.writeFileSync(path.join(f.base, 'cloud-recorded', id), '')
}

test('post bounds Cloud concurrency, overlaps cache save, and waits for all work', async t => {
  const f = fixture(t)
  for (const id of ['a', 'b', 'c']) addSuite(f, id)
  const started = [], releases = [], cache = {}
  let finished = false
  const saving = saveTogether([
    () => new Promise(resolve => { cache.started = true; cache.release = resolve }),
    () => saveCloudLedgers(f.base, (_, dir) => new Promise(resolve => {
      started.push(path.basename(dir)); releases.push(resolve)
    })),
  ]).then(results => { finished = true; return results })
  await new Promise(setImmediate)
  assert.equal(cache.started, true)
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(finished, false)
  releases[0]()
  await new Promise(setImmediate)
  assert.deepEqual(started, ['a', 'b', 'c'])
  releases[1](); releases[2]()
  await new Promise(setImmediate)
  assert.equal(finished, false, 'cache save still pending')
  cache.release()
  assert.deepEqual((await saving).map(x => x.status), ['fulfilled', 'fulfilled'])
})

test('one failed suite does not suppress another save or cache fallback', async t => {
  const f = fixture(t)
  for (const id of ['a', 'b', 'c']) addSuite(f, id)
  const called = []
  const results = await saveTogether([async () => 'cache saved', () => saveCloudLedgers(f.base, async (_, dir) => {
    const id = path.basename(dir); called.push(id)
    if (id === 'b') throw new Error('fixture failure')
  })])
  assert.deepEqual(called.sort(), ['a', 'b', 'c'])
  assert.equal(results[0].value, 'cache saved')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /1 Cloud ledger save/)
  assert.deepEqual(fs.readdirSync(path.join(f.base, 'cloud-recorded')), ['b'])
})

test('post invokes the CLI with literal suite arguments and waits for its exit', async t => {
  const f = fixture(t)
  const suite = 'package with spaces; $(echo should-not-run)'
  addSuite(f, 'literal', suite)
  const received = path.join(f.base, 'received.json')
  fs.writeFileSync(f.cfg.quod, '#!' + process.execPath + '\n' +
    'require("node:fs").writeFileSync(' + JSON.stringify(received) + ', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),active:process.env.QUOD_SHIM_ACTIVE}));\n')
  fs.chmodSync(f.cfg.quod, 0o755)
  assert.equal(await saveCloudLedgers(f.base), 1)
  const got = JSON.parse(fs.readFileSync(received))
  assert.deepEqual(got.args, ['vitest', '--dir', path.join(f.cfg.ledgers, 'literal'), '--cloud', '--suite', suite, '--cloud-only', 'save'])
  assert.equal(got.cwd, f.cfg.root)
  assert.equal(got.active, '1')
  addSuite(f, 'failed')
  fs.writeFileSync(f.cfg.quod, '#!' + process.execPath + '\nprocess.exit(3)\n')
  await assert.rejects(saveCloudLedgers(f.base), /exited 3/)
})

test('symlinked ledger or suite metadata is rejected before invoking the CLI', async t => {
  for (const kind of ['ledger', 'suite']) {
    const f = fixture(t)
    addSuite(f, 'bad')
    const p = kind === 'ledger' ? path.join(f.cfg.ledgers, 'bad') : path.join(f.cfg.ledgers, '.suites', 'bad')
    fs.rmSync(p, { recursive: true })
    fs.symlinkSync(f.cfg.root, p)
    await assert.rejects(saveCloudLedgers(f.base, () => assert.fail('invalid path accepted')), /not an ordinary/)
  }
})
