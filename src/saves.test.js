'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { saveTogether } = require('./saves')

test('uploads start together and completion waits for the slowest', async () => {
  let release, started = 0, finished = false
  const pending = new Promise((r) => { release = r })
  const result = saveTogether([
    async () => { started++; await pending; return 'slow' },
    async () => { started++; return 'fast' },
  ]).then((r) => { finished = true; return r })
  await new Promise(setImmediate)
  assert.equal(started, 2)
  assert.equal(finished, false)
  release()
  assert.deepEqual(await result, [{ status: 'fulfilled', value: 'slow' }, { status: 'fulfilled', value: 'fast' }])
})

test('a failed upload cannot abort or hide another successful save', async () => {
  const result = await saveTogether([() => { throw new Error('failed cache') }, async () => 'saved ledger'])
  assert.equal(result[0].status, 'rejected')
  assert.equal(result[1].value, 'saved ledger')
})
