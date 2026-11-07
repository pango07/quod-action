// Exercise the actual Action shim with a mutation outside shared project inputs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const config='vitest.config.mjs',saved=fs.existsSync(config)?fs.readFileSync(config):null
const inputs=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'realpath-inputs-'))
const logs=path.join(process.env.RUNNER_TEMP,'realpath-logs')
const report=path.join(process.env.RUNNER_TEMP,'realpath-report.json')
const link=path.join(inputs,'current'),input=path.join(link,'input')
const operations={
  sync:'fs.realpathSync(input)',native_sync:'fs.realpathSync.native(input)',
  callback:'await new Promise((resolve,reject)=>fs.realpath(input,(e,p)=>e?reject(e):resolve(p)))',
  native_callback:'await new Promise((resolve,reject)=>fs.realpath.native(input,(e,p)=>e?reject(e):resolve(p)))',
  promise:'await fs.promises.realpath(input)',
}
const files=Object.keys(operations).map(name=>'tests/realpath-'+name+'.test.js')
files.push('tests/realpath-control.test.js')
for(const file of files)assert.equal(fs.existsSync(file),false,'fixture must not replace a file')
fs.mkdirSync(logs,{recursive:true})
const runs=[]
function run(label,plain=false) {
  fs.rmSync(report,{force:true})
  const env={...process.env,QUOD_VITEST_LINEAGE:'0',QUOD_VITEST_TIMING:'off',
    QUOD_VITEST_NAMES_PROOF:'0',QUOD_VITEST_BOOLEAN_PROOF:'0',QUOD_DISABLE:plain?'1':'0',
    NODE_OPTIONS:`--require=${process.env.RUNNER_TEMP}/bench-vitest-report.cjs`,BENCH_VITEST_REPORT:report}
  delete env.QUOD_VITEST_JS_DIR
  const result=spawnSync('npm',['test'],{encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024,env})
  const log=(result.stdout??'')+(result.stderr??'')
  fs.writeFileSync(path.join(logs,label+'.log'),log)
  assert.equal(result.error,undefined);assert.ok(result.status===0||result.status===1,log)
  fs.copyFileSync(report,path.join(logs,label+'-report.json'))
  const data=JSON.parse(fs.readFileSync(report,'utf8'))
  const states=data.testResults.flatMap(f=>f.assertionResults.map(a=>[a.fullName,a.status])).sort()
  assert.equal(data.testResults.length,6);assert.equal(states.length,6)
  const row={label,exit:result.status,states};runs.push(row)
  fs.writeFileSync(path.join(logs,'runs.json'),JSON.stringify(runs,null,2)+'\n')
  return {...row,log}
}
try {
  for(const name of ['a','b']){fs.mkdirSync(path.join(inputs,name));fs.writeFileSync(path.join(inputs,name,'input'),'same bytes\n')}
  fs.symlinkSync('a',link)
  for(const [name,expression] of Object.entries(operations)) {
    fs.writeFileSync('tests/realpath-'+name+'.test.js',`import fs from 'node:fs';import {test,expect} from 'vitest';
const input=${JSON.stringify(input)};
test(${JSON.stringify(name)},async()=>expect(${expression}).toBe(${JSON.stringify(path.join(inputs,'a/input'))}));\n`)
  }
  fs.writeFileSync(files.at(-1),`import fs from 'node:fs';import {test,expect} from 'vitest';
test('content control',()=>expect(fs.readFileSync(${JSON.stringify(input)},'utf8')).toBe('same bytes\\n'));\n`)
  fs.writeFileSync(config,`export default {css:{postcss:{}},test:{include:${JSON.stringify(files)},maxWorkers:1}};\n`)
  fs.rmSync(path.join(process.env.RUNNER_TEMP,'quod/vitest'),{recursive:true,force:true})
  const initial=run('plain-before',true)
  assert.equal(initial.exit,0);assert.ok(initial.states.every(([,s])=>s==='passed'))
  for(const label of ['record','witness','warm']) {
    const row=run(label);assert.equal(row.exit,0,row.log);assert.deepEqual(row.states,initial.states)
    if(label==='warm')assert.match(row.log,/6 test files: running [0-5], replaying [1-6]/)
  }
  fs.unlinkSync(link);fs.symlinkSync('b',link)
  const changed=run('changed-quod'),plain=run('changed-plain',true)
  assert.equal(plain.exit,1);assert.equal(plain.states.filter(([,s])=>s==='failed').length,5)
  assert.equal(changed.exit,plain.exit,changed.log);assert.deepEqual(changed.states,plain.states)
  assert.match(changed.log,/6 test files: running 5, replaying 1/)
  console.log('Packaged realpath: all five changed results match plain; the content control still replays.')
}finally{
  for(const file of files)fs.rmSync(file,{force:true})
  fs.rmSync(inputs,{recursive:true,force:true})
  if(saved===null)fs.rmSync(config,{force:true});else fs.writeFileSync(config,saved)
}
