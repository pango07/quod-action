'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {uploadMatrixReports} = require('./matrix-reports')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-matrix-reports-'))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  const calls = [], messages = []
  const options = {directory, job: 'test', attempt: '2',
    client: {async uploadArtifact(...args) {calls.push(args)}}, leaks: () => null,
    info: value => messages.push(value), warning: value => messages.push(value)}
  return {directory, calls, messages, options}
}
test('matrix artifacts contain honest logical files and summary, never native subset JSON or auth files', async t => {
  const f = fixture(t)
  for (const name of ['matrix-run-a.logical.json', 'matrix-run-a.summary.json', 'native-report.json', 'managed-cache-auth.json'])
    fs.writeFileSync(path.join(f.directory, name), '{}\n')
  assert.deepEqual(await uploadMatrixReports(f.options), {uploaded: true, name: 'quod-managed-matrix-logical-test-2', files: 2})
  assert.deepEqual(f.calls[0][1].map(file => path.basename(file)), ['matrix-run-a.logical.json', 'matrix-run-a.summary.json'])
  assert.equal(f.calls[0][2], f.directory)
  assert.match(f.messages[0], /native subset JSON is not a full-suite report/)
})
test('missing reports, credential values and symlinked reports never upload', async t => {
  const f = fixture(t)
  assert.equal((await uploadMatrixReports(f.options)).reason, 'no-logical-report')
  const file = path.join(f.directory, 'matrix-run-a.logical.json')
  fs.writeFileSync(file, '{}\n')
  assert.equal((await uploadMatrixReports({...f.options, leaks: () => 'runtime token'})).reason, 'credential-value')
  fs.rmSync(file); fs.symlinkSync('missing', file)
  await assert.rejects(uploadMatrixReports(f.options), /regular invocation file/)
  assert.equal(f.calls.length, 0)
})
