'use strict'
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function receiptPrefix(executionKey, namespace = '') {
  if (!digest(executionKey) || !/^(?:[A-Za-z0-9._-]{1,80}-)?$/.test(namespace)) throw new Error('invalid managed cache scope')
  return `quod-managed-v1-${namespace}${executionKey}-`
}
// Call only with the actual return value of the authenticated cache client.
function trustedDigest(matchedServiceKey, executionKey, namespace = '') {
  const prefix = receiptPrefix(executionKey, namespace)
  if (typeof matchedServiceKey !== 'string' || !matchedServiceKey.startsWith(prefix)) return null
  const suffix = matchedServiceKey.slice(prefix.length)
  return digest(suffix) ? suffix : null
}
module.exports = {receiptPrefix, trustedDigest}
