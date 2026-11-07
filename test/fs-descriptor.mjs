// Exercise the Action's actual npm/node shim, packaged binary and ledger.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const config='vitest.config.mjs',input='fd-metadata-input.txt'
const files=['tests/fd-metadata.test.js','tests/fd-control.test.js',input]
const saved=fs.existsSync(config)?fs.readFileSync(config):null
for(const file of files)assert.equal(fs.existsSync(file),false,'fixture must not replace an existing file')
const logs=path.join(process.env.RUNNER_TEMP,'fs-descriptor-logs')
const report=path.join(process.env.RUNNER_TEMP,'fs-descriptor-report.json')
fs.mkdirSync(logs,{recursive:true})
const runs=[]
function run(label,plain=false) {
  fs.rmSync(report,{force:true})
  const env={...process.env,QUOD_VITEST_LINEAGE:'0',QUOD_VITEST_TIMING:'off',
    QUOD_VITEST_NAMES_PROOF:'0',QUOD_VITEST_BOOLEAN_PROOF:'0',QUOD_DISABLE:plain?'1':'0',
    NODE_OPTIONS:`--require=${process.env.RUNNER_TEMP}/bench-vitest-report.cjs`,BENCH_VITEST_REPORT:report}
  delete env.QUOD_VITEST_JS_DIR
  const result=spawnSync('npm',['test'],{encoding:'utf8',timeout:90000,env})
  const log=(result.stdout??'')+(result.stderr??'')
  fs.writeFileSync(path.join(logs,label+'.log'),log)
  assert.equal(result.error,undefined);assert.ok(result.status===0||result.status===1,log)
  fs.copyFileSync(report,path.join(logs,label+'-report.json'))
  const data=JSON.parse(fs.readFileSync(report,'utf8'))
  const states=data.testResults.flatMap(f=>f.assertionResults.map(a=>[a.fullName,a.status])).sort()
  assert.equal(data.testResults.length,2);assert.equal(states.length,4)
  const row={label,exit:result.status,states};runs.push(row)
  fs.writeFileSync(path.join(logs,'runs.json'),JSON.stringify(runs,null,2)+'\n')
  return {...row,log}
}
try {
  fs.writeFileSync(config,`export default {css:{postcss:{}},test:{include:${JSON.stringify(files.slice(0,2))},maxWorkers:1}};\n`)
  fs.writeFileSync(input,'unchanged bytes\n');fs.utimesSync(input,1577836800,1577836800)
  fs.writeFileSync(files[0],`import fs from 'node:fs';import {test,expect} from 'vitest';
const file=${JSON.stringify(input)};
test('sync descriptor mtime',()=>{const fd=fs.openSync(file,'r');try{
 expect(fs.fstatSync(fd).mtimeMs).toBe(1577836800000);
}finally{fs.closeSync(fd)}});
test('callback descriptor mtime',async()=>{const fd=fs.openSync(file,'r');try{
 const stat=await new Promise((resolve,reject)=>fs.fstat(fd,(e,s)=>e?reject(e):resolve(s)));
 expect(stat.mtimeMs).toBe(1577836800000);
}finally{fs.closeSync(fd)}});
test('FileHandle mtime',async()=>{const handle=await fs.promises.open(file,'r');try{
 expect((await handle.stat()).mtimeMs).toBe(1577836800000);
}finally{await handle.close()}});\n`)
  fs.writeFileSync(files[1],`import fs from 'node:fs';import {test,expect} from 'vitest';
test('ordinary content control',()=>expect(fs.readFileSync(${JSON.stringify(input)},'utf8')).toBe('unchanged bytes\\n'));\n`)
  fs.rmSync(path.join(process.env.RUNNER_TEMP,'quod/vitest'),{recursive:true,force:true})
  const initial=run('plain-before',true)
  assert.equal(initial.exit,0);assert.ok(initial.states.every(([,s])=>s==='passed'))
  for(const label of ['record','witness','warm']) {
    const row=run(label);assert.equal(row.exit,0,row.log);assert.deepEqual(row.states,initial.states)
    if(label==='warm')assert.match(row.log,/2 test files: running 1, replaying 1/)
  }
  const bytes=fs.readFileSync(input);fs.utimesSync(input,1609459200,1609459200)
  assert.deepEqual(fs.readFileSync(input),bytes)
  const changed=run('changed-quod'),plain=run('changed-plain',true)
  assert.equal(plain.exit,1,plain.log);assert.equal(plain.states.filter(([,s])=>s==='failed').length,3)
  assert.equal(changed.exit,plain.exit,changed.log);assert.deepEqual(changed.states,plain.states)
  assert.match(changed.log,/2 test files: running 1, replaying 1/)
  console.log('Packaged filesystem descriptors: all three metadata failures match plain; the content control still replays.')
}finally{
  for(const file of files)fs.rmSync(file,{force:true})
  if(saved===null)fs.rmSync(config,{force:true});else fs.writeFileSync(config,saved)
}
