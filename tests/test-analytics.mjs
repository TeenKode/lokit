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
// Imported or legacy records may contain string, negative or overflowing durations.
const now=new Date().toISOString();
localStorage.setItem('lokit:analytics:v1',JSON.stringify([
 {id:'string',ts:now,kind:'success',tool:'video-trim',durationMs:'125'},
 {id:'negative',ts:now,kind:'error',tool:'video-trim',durationMs:-50},
 {id:'invalid',ts:now,kind:'cancelled',tool:'video-trim',durationMs:'not-a-number'},
 {id:'overflow',ts:now,kind:'success',tool:'video-trim',durationMs:1e100},
 {id:'valid',ts:now,kind:'success',tool:'video-trim',durationMs:75}
]));
const durationSummary=a.summarizeLocal(7);
assert.equal(durationSummary.tools[0].durationMs,86400200);
assert.equal(typeof durationSummary.tools[0].durationMs,'number');
console.log('Local analytics: private, export, clear, history limit and time windows — PASS');
