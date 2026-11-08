import fs from 'node:fs'
import {expect, test} from 'vitest'

test('reads the tracked input', () => {
  expect(fs.readFileSync(new URL('../data/value.txt', import.meta.url), 'utf8')).toBe('9\n')
})
test('reads the declared environment input', () => {
  expect(process.env.PRODUCT_WITNESS_SCOPE).toMatch(/^[0-9]+-[0-9]+$/)
  expect(process.env.PRODUCT_INPUT).toBe('7')
})
test('retains controlled console output', () => console.log('QUOD_PRODUCT_CONTROLLED_OUTPUT:v1'))
