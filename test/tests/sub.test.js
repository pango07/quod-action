import { expect, test } from 'vitest'
import { sub } from '../src/math.js'

test('subtracts', () => expect(sub(3, 2)).toBe(1))
