'use strict'
// The runner gives its cache session to JavaScript actions, not later shell
// steps. Keep the session in a private job-local file; never export or cache it.
const fs = require('node:fs')
const KEYS = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_SERVICE_V2', 'ACTIONS_RUNTIME_URL']
function captureCacheAuth(file, environment = process.env) {
  const data = Object.fromEntries(KEYS.filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]))
  fs.writeFileSync(file, JSON.stringify(data), {mode: 0o600, flag: 'wx'})
}
function loadCacheAuth(file) {
  if (!file) return {}
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.entries(data).some(([key, value]) => !KEYS.includes(key) || typeof value !== 'string')) {
    throw new Error('invalid managed cache session')
  }
  return data
}
async function withCacheAuth(auth, operation) {
  const previous = KEYS.map(key => [key, Object.hasOwn(process.env, key), process.env[key]])
  try {
    for (const key of KEYS) {
      if (Object.hasOwn(auth, key)) process.env[key] = auth[key]
    }
    return await operation()
  } finally {
    for (const [key, present, value] of previous) {
      if (present) process.env[key] = value
      else delete process.env[key]
    }
  }
}
module.exports = {captureCacheAuth, loadCacheAuth, withCacheAuth}
