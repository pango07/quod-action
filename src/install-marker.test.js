'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')
const source = hook.slice(hook.indexOf('function npmCi('), hook.indexOf('\n// `npm run <script>`'))

test('successful fresh installs expose the same marker before build as restored trees', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-marker-'))
  try {
    const root = fs.realpathSync(base), npm = path.join(root, 'npm'), bin = path.join(npm, 'bin/npm-cli.js')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(bin, '')
    fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"11"}')
    fs.writeFileSync(path.join(root, 'deps.json'), JSON.stringify({ pm: 'npm', root, ws: root, paths: [], facts: { npm: '11' } }))
    let done
    const D = { NPM_CI: ['ci'], npmArgs: x => x, key: () => 'key', fullPrint: () => 'print' }
    const context = { __dirname: root, require: n => n.endsWith('deps.cjs') ? D : require(n),
      process: { cwd: () => root, version: process.version, execPath: process.execPath, on: (name, fn) => { assert.equal(name, 'exit'); done = fn } } }
    vm.runInNewContext(source + '; npmCi(' + JSON.stringify(bin) + ', ["ci"])', context)
    assert.equal(fs.existsSync(path.join(root, 'node_modules/.quod-deps.json')), false)
    done(1)
    assert.equal(fs.existsSync(path.join(root, 'node_modules/.quod-deps.json')), false)
    done(0)
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/.quod-deps.json')))
    assert.deepEqual(marker, { key: 'key', args: [], npm: '11' })
    assert.equal(fs.existsSync(path.join(root, 'deps-installed.json')), true)
    const fresh = fs.readdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'node_modules/.quod-deps.json'), JSON.stringify(marker))
    assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules')), fresh)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
