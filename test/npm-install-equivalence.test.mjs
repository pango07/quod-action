import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {inventory, difference, normalizeHidden} from './npm-install-equivalence.mjs'

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-inventory-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  fs.writeFileSync(path.join(root, '.package-lock.json'), '{"version":"old","packages":{}}\n')
  fs.mkdirSync(path.join(root, 'pkg')); fs.writeFileSync(path.join(root, 'pkg/file'), 'aa')
  fs.chmodSync(path.join(root, 'pkg/file'), 0o644)
  fs.symlinkSync('pkg/file', path.join(root, 'link'))
  return root
}
test('full inventories detect same-length byte, permission, symlink and roster changes', t => {
  const root = tree(t), before = inventory(root, 'old').compared
  fs.writeFileSync(path.join(root, 'pkg/file'), 'bb')
  assert.deepEqual(difference(before, inventory(root, 'old').compared).map(row => row.path), ['pkg/file'])
  fs.writeFileSync(path.join(root, 'pkg/file'), 'aa'); fs.chmodSync(path.join(root, 'pkg/file'), 0o700)
  assert.deepEqual(difference(before, inventory(root, 'old').compared).map(row => row.path), ['pkg/file'])
  fs.chmodSync(path.join(root, 'pkg/file'), 0o644)
  fs.unlinkSync(path.join(root, 'link')); fs.symlinkSync('pkg/missing', path.join(root, 'link'))
  assert.deepEqual(difference(before, inventory(root, 'old').compared).map(row => row.path), ['link'])
  fs.unlinkSync(path.join(root, 'link')); fs.symlinkSync('pkg/file', path.join(root, 'link'))
  fs.rmSync(path.join(root, 'pkg/file')); fs.writeFileSync(path.join(root, 'new-file'), 'cc')
  assert.deepEqual(difference(before, inventory(root, 'old').compared).map(row => [row.path, row.change]),
    [['new-file', 'added'], ['pkg/file', 'removed']])
})
test('runtime exclusions apply only at node_modules roots and remain in the raw inventory', t => {
  const root = tree(t)
  for (const name of ['.cache', 'pkg/.cache', 'pkg/node_modules/.vite']) {
    fs.mkdirSync(path.join(root, name), {recursive: true}); fs.writeFileSync(path.join(root, name, 'data'), 'present')
  }
  fs.writeFileSync(path.join(root, '.quod-deps.json'), '{}')
  const result = inventory(root, 'old')
  assert.deepEqual(result.exclusions.map(row => row.path).sort(), ['.cache', '.quod-deps.json', 'pkg/node_modules/.vite'])
  assert.ok(result.raw.some(row => row.path === '.cache/data' && row.excludedBy === '.cache'))
  assert.ok(result.compared.some(row => row.path === 'pkg/.cache/data'))
  assert.ok(!result.compared.some(row => row.path === 'pkg/node_modules/.vite/data'))
})
test('the hidden-lock rewrite is conditional and preserves every non-version field', () => {
  const bytes = Buffer.from('{"version":"old","name":"root","packages":{"node_modules/x":{"version":"old"}}}\n')
  assert.deepEqual(normalizeHidden(bytes, 'old'), bytes)
  assert.deepEqual(normalizeHidden(bytes, 'new'), Buffer.from(JSON.stringify({version: 'new', name: 'root', packages: {'node_modules/x': {version: 'old'}}}, null, 2) + '\n'))
  assert.deepEqual(JSON.parse(normalizeHidden(bytes, undefined)), {name: 'root', packages: {'node_modules/x': {version: 'old'}}})
})
