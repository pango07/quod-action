import {expect, test} from 'vitest'
import {add, square} from '../src/math.js'

test('adds integers', () => {
  expect(process.env.PRODUCT_WITNESS_SCOPE).toMatch(/^[0-9]+-[0-9]+$/)
  expect(add(12, 30)).toBe(42)
})
test('duplicate assertion name', () => expect(square(3)).toBe(9))
test('duplicate assertion name', () => expect(square(-3)).toBe(9))
test.skip('retains a skipped assertion', () => expect(false).toBe(true))
