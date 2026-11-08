import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {base, fixture, json, runIdentity, sha, workspace, write} from './product-readiness-common.mjs'

const [role, output] = process.argv.slice(2)
assert(['plain', 'record', 'witness', 'replay', 'changed', 'fallback'].includes(role) && output)
const value = {schema: 'quod-product-npm-ci-evidence-v1', role, identity: runIdentity(), passed: false,
  argv: ['npm', 'ci', '--no-audit', '--no-fund']}
const modules = path.join(fixture(), 'node_modules'), installed = path.join(base(), 'deps-installed.json')
function tree() {
  const rows = []; let bytes = 0, nativeBytes = 0
  const walk = (directory, depth = 0) => {
    assert(depth <= 32)
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file)
      const name = path.relative(modules, file).split(path.sep).join('/')
      assert(rows.length < 50000)
      if (stat.isDirectory()) {rows.push([name, 'directory', stat.mode & 0o777]); walk(file, depth + 1)}
      else if (stat.isSymbolicLink()) rows.push([name, 'symlink', fs.readlinkSync(file)])
      else {
        assert(stat.isFile()); bytes += stat.size; assert(bytes <= 256 * 1024 * 1024)
        if (name !== '.quod-deps.json') nativeBytes += stat.size
        rows.push([name, 'file', stat.mode & 0o777, sha(fs.readFileSync(file))])
      }
    }
  }
  walk(modules)
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  const nativeRows = rows.filter(row => row[0] !== '.quod-deps.json')
  return {sha256: sha(JSON.stringify(rows)), paths: rows.length, bytes,
    nativeProjection: {sha256: sha(JSON.stringify(nativeRows)), paths: nativeRows.length, bytes: nativeBytes}}
}
try {
  assert.equal(process.env.PRODUCT_WITNESS_SCOPE, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
  const ordinary = role === 'plain', cold = role === 'record'
  let state, before
  assert(!fs.existsSync(installed), 'fresh jobs cannot inherit an in-process npm success marker')
  if (ordinary) assert(!fs.existsSync(modules))
  else {
    state = json(path.join(base(), 'deps.json'))
    assert.equal(state.pm, 'npm'); assert.equal(state.root, fs.realpathSync(fixture())); assert.equal(state.ws, workspace())
    assert(!state.installProfile, 'ordinary production acceptance must not use a finite install profile')
    assert.match(state.key, /^[a-f0-9]{40}$/)
    const expected = `quod-deps-product-readiness-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-npm-linux-x64-${state.key}`
    assert.equal(state.cacheKey, expected)
    assert.equal(state.hit, cold ? '' : 'exact', 'record is cold; each fresh successor must restore the exact saved dependency tree')
    assert.equal(fs.existsSync(modules), !cold)
    if (!cold) {
      const marker = json(path.join(modules, '.quod-deps.json'))
      assert.equal(marker.key, state.key); assert.deepEqual(marker.args, []); assert.equal(marker.npm, state.facts.npm)
      before = tree()
    }
    value.cache = {hit: state.hit, key: state.key, cacheKey: state.cacheKey, npm: state.facts.npm, finiteInstallProfile: false}
  }
  const child = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {cwd: fixture(), env: process.env,
    encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024})
  assert(!child.error && child.signal === null && child.status === 0, 'actual npm ci must succeed')
  const text = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
  const skipped = /quod: node_modules is what `npm ci` installs here .*npm ci skipped/.test(text)
  assert.equal(skipped, !ordinary && !cold)
  assert.equal(json(path.join(modules, 'vitest/package.json')).version, '5.0.0')
  value.afterTree = tree()
  if (!ordinary && !cold) {
    assert.deepEqual(value.afterTree, before, 'an accepted exact cache hit must leave all node_modules contents and modes unchanged')
    assert(!fs.existsSync(installed), 'a skipped npm invocation must not synthesize a fresh install-success marker')
    value.beforeTree = before
  } else if (cold) {
    const success = json(installed), marker = json(path.join(modules, '.quod-deps.json'))
    assert.equal(success.key, state.key); assert.deepEqual(success.args, []); assert.match(success.print, /^[a-f0-9]{64}$/)
    assert.equal(marker.key, state.key); assert.deepEqual(marker.args, []); assert.equal(marker.npm, state.facts.npm)
    value.realInstallMarker = {keyMatched: true, argsMatched: true, treePrintSha256: success.print}
  } else assert(!fs.existsSync(path.join(modules, '.quod-deps.json')))
  value.exitCode = child.status; value.actualNpmCiSkipped = skipped; value.capturedOutputSha256 = sha(text)
  value.passed = true
} catch (error) {
  value.error = {name: error.name, message: String(error.message).slice(0, 1000)}
  process.exitCode = 1
} finally {write(path.join(output, 'installation.json'), value)}
