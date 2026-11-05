'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const hook = fs.readFileSync(path.join(__dirname, '../hook.cjs'), 'utf8')

function attempt(version, args = ['run'], versions = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quod-compat-'))
  try {
    const root = fs.realpathSync(base), pkg = path.join(root, 'node_modules/vitest'), bin = path.join(pkg, 'vitest.mjs')
    fs.mkdirSync(pkg, {recursive:true})
    fs.writeFileSync(bin, '')
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({version}))
    const quod = path.join(root, 'quod')
    fs.writeFileSync(quod, '')
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({root, quod, ledgers:path.join(root,'ledgers'), reports:path.join(root,'reports')}))
    let calls = 0, exited = false
    const messages = []
    vm.runInNewContext(hook, {__dirname:root, console:{error:m=>messages.push(m)},
      require:n=>n === 'node:child_process' ? {spawnSync:()=>{calls++; return {status:0}}} : require(n),
      process:{argv:[process.execPath, bin, ...args], env:{CI:'1'}, versions, cwd:()=>root, exit:code=>{assert.equal(code,0); exited=true}}})
    return {calls,exited,messages}
  } finally {fs.rmSync(base,{recursive:true,force:true})}
}
test('only implemented Vitest major versions enter replay', () => {
  for (const v of ['3.2.0','3.3.1','4.0.0','5.0.0','5.0.0+build.1']) {
    const result=attempt(v)
    assert.equal(result.calls,1,v)
    assert.equal(result.exited,true,v)
  }
  for (const v of ['2.9.0','3.1.9','6.0.0','99.0.0','unknown','','4','4.invalid','5.0.0-beta.1']) {
    const result=attempt(v)
    assert.equal(result.calls,0,v)
    assert.equal(result.exited,false,v)
    assert.match(result.messages.join('\n'),/running plain vitest/,v)
  }
})
test('unsupported modes and Yarn PnP stay in the original Vitest command', () => {
  for (const args of [['watch'], ['run','--browser'], ['run','--shard=1/2'], ['run','--update'], ['run','--changed']]) {
    const result=attempt('5.0.0',args)
    assert.equal(result.calls,0)
    assert.equal(result.exited,false)
  }
  const pnp=attempt('5.0.0',['run'],{pnp:'3'})
  assert.equal(pnp.calls,0)
  assert.equal(pnp.exited,false)
  assert.match(pnp.messages.join('\n'),/running plain vitest/)
})
