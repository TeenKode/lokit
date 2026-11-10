import assert from 'node:assert/strict';
import {BatchQueue,groupFiles,isBatchTool} from '../js/batch-queue.js';
const f=name=>Object.assign(new Blob(['sample']),{name});
const single={id:'subtitle-converter',title:'Конвертация',async run(){},requiredFiles:1};
const pair={id:'video-merge',title:'Склейка',async run(){},requiredFiles:2,maxFiles:2};
assert.equal(isBatchTool(single),true);
assert.equal(isBatchTool({isCapture:true,run(){}}),false);
assert.equal(groupFiles(single,[f('a.srt'),f('b.srt')]).length,2);
assert.deepEqual(groupFiles(pair,[f('a'),f('b'),f('c'),f('d')]).map(x=>x.map(y=>y.name)),[['a','b'],['c','d']]);
assert.throws(()=>groupFiles(pair,[f('a')]),/группами по 2/);
assert.throws(()=>groupFiles({isCapture:true,run(){}},[f('a')]),/недоступна/);
let updates=0;const calls=[];let gateResolve;
const blocked=new Promise(resolve=>{gateResolve=resolve;});
let failFirst=true;
const queue=new BatchQueue({maxJobs:5,onChange:()=>{updates++;},execute:async(job,signal,progress)=>{
  calls.push({id:job.id,tool:job.tool.id,values:{...job.values}});
  if(job.files[0].name==='a.srt'){
    progress({stage:'processing',percent:30});
    await blocked;
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    progress({percent:70});
  }
  if(job.files[0].name==='b.srt'&&failFirst){failFirst=false;throw Error('Bad format');}
  if(job.files[0].name==='d.srt'){
    await new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new DOMException('Cancel','AbortError')),{once:true});
    });
  }
  return {name:job.files[0].name+'.vtt',blob:new Blob(['ok'])};
}});
const source={level:'3'};
queue.add(single,[f('a.srt'),f('b.srt')],source);
source.level='7';
assert.equal(queue.jobs[0].values.level,'3','Snapshot options per job');
const run=queue.start();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(queue.snapshot().counts.running,1);
assert.equal(queue.jobs[0].percent,30);
assert.equal(queue.snapshot().percent,15);
queue.pause();
gateResolve();await run;
assert.equal(queue.snapshot().counts.success,1);
assert.equal(queue.snapshot().counts.pending,1,'Pause applies after current job');
assert.equal(queue.running,false);
await queue.start();
assert.equal(queue.snapshot().counts.error,1);
assert.match(queue.jobs[1].error,/Bad format/);
assert.equal(queue.retryFailed(),1);
await queue.start();
assert.equal(queue.snapshot().counts.success,2);
assert.equal(queue.jobs[0].result.blob.size,2);
queue.add(single,[f('d.srt')],{});
const run2=queue.start();await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(queue.snapshot().counts.running,1);
assert.equal(queue.cancel(queue.jobs[2].id),true);
await run2;
assert.equal(queue.snapshot().counts.cancelled,1);
assert.equal(queue.jobs[2].result,null,'Never return a cancelled output');
queue.add(single,[f('e.srt')],{});
assert.equal(queue.cancel(queue.jobs[3].id),true);
assert.equal(queue.snapshot().counts.cancelled,2);
assert.equal(queue.retryFailed(),2);
// e.srt can finish; d.srt is cancelled again, leaving the subsequent tasks pending.
const resumed=queue.start();await new Promise(resolve=>setTimeout(resolve,0));queue.cancel(queue.jobs[2].id);await resumed;
assert.equal(queue.snapshot().counts.success,3);
queue.clearFinished();assert.equal(queue.jobs.length,0);
assert.throws(()=>queue.add(single,[f('1'),f('2'),f('3'),f('4'),f('5'),f('6')],{}),/не более/);
assert(updates>10);
console.log('PASS batch queue: grouping, mixed options, progress, pause, failures, retry, cancel, memory cleanup, limit');
