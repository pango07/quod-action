'use strict'
const fs = require('node:fs')
const path = require('node:path')

async function uploadMatrixReports({directory, job, attempt, client, leaks, info, warning}) {
  const files = fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter(name => /\.logical\.json$|\.summary\.json$/.test(name)).sort()
    .map(name => path.join(directory, name)) : []
  if (!files.length) return {uploaded: false, reason: 'no-logical-report'}
  if (files.some(file => {const stat = fs.lstatSync(file); return !stat.isFile() || stat.isSymbolicLink()})) {
    throw new Error('matrix report must be a regular invocation file')
  }
  const secret = leaks(files)
  if (secret) {
    warning(`Quod matrix: logical reports contain the value of ${secret}; not uploaded`)
    return {uploaded: false, reason: 'credential-value'}
  }
  const name = `quod-managed-matrix-logical-${job}${Number(attempt) > 1 ? '-' + attempt : ''}`
  await client.uploadArtifact(name, files, directory, {retentionDays: 3})
  info(`Quod matrix: logical names/states and exit metadata retained (${name}); native subset JSON is not a full-suite report`)
  return {uploaded: true, name, files: files.length}
}

module.exports = {uploadMatrixReports}
