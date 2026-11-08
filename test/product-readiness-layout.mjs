import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {pins} from './product-readiness-common.mjs'
const exclude = path.join(process.env.GITHUB_WORKSPACE, '.git/info/exclude')
fs.appendFileSync(exclude, '\n/.quod-action/\n')
if (execFileSync('git', ['check-ignore', '.quod-action'], {cwd: process.env.GITHUB_WORKSPACE, encoding: 'utf8'}).trim() !== '.quod-action') {
  throw new Error('the shipped Action checkout must be ignored by the customer repository')
}
pins()
console.log('Exact shipped Action, tracked fixture lock and sparse customer-root layout verified.')
