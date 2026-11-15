import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const base=path.dirname(fileURLToPath(import.meta.url));
const temp=path.join(base,'.tmp-modules');mkdirSync(temp,{recursive:true});
writeFileSync(path.join(temp,'package.json'),'\{"type":"module"\}');
writeFileSync(path.join(temp,'analytics.js'),readFileSync(path.join(base,'..','js','analytics.js')));
const memory=new Map([['lokit:analytics:queue:v1','[1]'],['lokit:analytics:share:v1','true']]);
globalThis.localStorage={getItem:key=>memory.has(key)?memory.get(key):null,setItem:(key,v)=>memory.set(key,String(v)),removeItem:key=>memory.delete(key)};
let requests=0;globalThis.fetch=()=>{requests++;throw new Error('No network analytics allowed')};
const a=await import('./.tmp-modules/analytics.js');
assert.equal(memory.has('lokit:analytics:queue:v1'),false);
assert.equal(memory.has('lokit:analytics:share:v1'),false);
a.recordEvent('view');a.recordEvent('open','video-trim');
a.recordOperation('video-trim','success',[{size:1024}],{blob:{size:512}},2150);
const summary=a.summarizeLocal(30);
assert.equal(summary.kinds.find(e=>e.kind==='success').count,1);
assert.equal(summary.tools[0].inputBytes,1024);
assert.equal(summary.tools[0].outputBytes,512);
assert.equal(JSON.parse(a.exportLocalEvents()).events.length,3);
for(let i=0;i<1300;i++)a.recordEvent('open','video-trim');
assert.equal(a.localEvents().length,1200);
assert.equal(requests,0);
a.clearLocalEvents();assert.equal(a.localEvents().length,0);
const today=new Date();today.setUTCHours(0,0,0,0);
localStorage.setItem('lokit:analytics:v1',JSON.stringify([
 {id:'in',ts:new Date(+today-6*86400000).toISOString(),kind:'success',tool:'video-trim'},
 {id:'out',ts:new Date(+today-7*86400000).toISOString(),kind:'error',tool:'video-trim'}
]));
assert.equal(a.summarizeLocal(7).kinds.find(e=>e.kind==='success').count,1);
assert.equal(a.summarizeLocal(7).kinds.some(e=>e.kind==='error'),false);
console.log('Local analytics: private, export, clear, history limit and time windows — PASS');

const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
try{
 a.clearLocalEvents();
 a.recordEvent('open','video-trim',null);
 a.recordEvent('open','video-trim',42);
 assert.equal(a.localEvents().length,2);
 assert.match(a.localEvents()[0].id,/^local-/);
}finally{
 if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else delete globalThis.crypto;
}
a.clearLocalEvents();
a.recordOperation('video-trim','success',[{size:1024},{size:NaN},{size:-1}],{blob:{size:512}},100);
assert.equal(a.summarizeLocal(7).tools[0].inputBytes,1024);
const now=new Date().toISOString();
localStorage.setItem('lokit:analytics:v1',JSON.stringify([
 {ts:now,kind:'success',tool:'video-trim',durationMs:'125',inputBytes:'1024',outputBytes:'512'},
 {ts:now,kind:'success',tool:'video-trim',durationMs:-5,inputBytes:-1,outputBytes:'invalid'},
 {ts:[now],kind:'success',tool:'video-trim'},
 {ts:2020,kind:'success',tool:'video-trim'},
 {ts:null,kind:'success',tool:'video-trim'}
]));
assert.equal(a.localEvents().length,2);
const normalized=a.summarizeLocal(7).tools[0];
assert.equal(normalized.durationMs,125);
assert.equal(normalized.inputBytes,1024);
assert.equal(normalized.outputBytes,512);
const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError');}});
try{
 // Reload the module to cover its one-time legacy storage cleanup too.
 const blocked=await import('./.tmp-modules/analytics.js?blocked');
 assert.doesNotThrow(()=>blocked.recordEvent('view'));
 assert.deepEqual(blocked.localEvents(),[]);
}finally{Object.defineProperty(globalThis,'localStorage',descriptor);}
console.log('PASS analytics: disabled storage/crypto, malformed timestamps, metadata and numeric aggregation');
