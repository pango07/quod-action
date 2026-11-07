'use strict'
// Test reports remain inline. Ledger publication can wait until every test
// command has finished, and overlap the Actions cache uploads in post.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

function saveOne(cfg, dir, suite) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.quod, ['vitest', '--dir', dir, '--cloud', '--suite', suite, '--cloud-only', 'save'], {
      cwd: cfg.root,
      env: { ...process.env, ...cfg.cloud, QUOD_SHIM_ACTIVE: '1' },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Cloud ledger save exited ${signal || code}`))
    })
  })
}

async function saveCloudLedgers(base, run = saveOne) {
  const dirty = path.join(base, 'cloud-recorded')
  if (!fs.existsSync(dirty)) return 0
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'))
  if (!cfg.cloud || cfg.deferCloudSave !== true) return 0
  const ids = fs.readdirSync(dirty, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort()
  const errors = []
  let next = 0, saved = 0
  // Each CLI has its own bounded blob uploader; do not start an unbounded
  // number of CLIs in a monorepo. Both workers finish before post returns.
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
    for (;;) {
      const id = ids[next++]
      if (id === undefined) return
      try {
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') throw new Error('invalid ledger directory name')
        const dir = path.join(cfg.ledgers, id)
        const name = path.join(cfg.ledgers, '.suites', id)
        if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(name).isFile()) throw new Error('ledger or suite is missing or not an ordinary file/directory')
        const suite = fs.readFileSync(name, 'utf8')
        await run(cfg, dir, suite)
        fs.rmSync(path.join(dirty, id))
        saved++
      } catch (error) {
        errors.push(error)
      }
    }
  }))
  if (errors.length) throw new Error(`${errors.length} Cloud ledger save(s) could not run: ${errors[0].message}`)
  return saved
}

module.exports = { saveCloudLedgers }
