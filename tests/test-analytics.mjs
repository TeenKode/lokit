import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const base=path.dirname(fileURLToPath(import.meta.url));
const temp=path.join(base,'.tmp-modules');mkdirSync(temp,{recursive:true});
writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
writeFileSync(path.join(temp,'analytics.js'),readFileSync(path.join(base,'..','js','analytics.js')));
writeFileSync(path.join(temp,'analytics-config.js'),"export const GLOBAL_ANALYTICS_URL='https://analytics.example';\n");
const memory=new Map();
globalThis.localStorage={getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
globalThis.dispatchEvent=()=>true;
const posts=[];
globalThis.fetch=async(url,options)=>{
  if(options?.method==='POST'){
    const body=JSON.parse(options.body);assert(body.events.length<=30);
    posts.push(...body.events);
    return {ok:true,status:200,json:async()=>({ok:true})};
  }
  return {ok:true,status:200,json:async()=>({version:1,kinds:[],tools:[],daily:[]})};
};
const a=await import('./.tmp-modules/analytics.js');
assert.equal(a.isGlobalConnected(),true);
assert.equal(a.isSharingEnabled(),false,'Sharing must require opt-in');
a.recordEvent('view');
await a.flushPending();
assert.equal(posts.length,0,'No uploads before consent');
a.setSharingEnabled(true);
a.recordEvent('open','video-trim');
a.recordOperation('video-trim','success',[{size:1024}],{blob:{size:512}},2100);
await a.flushPending();
let stats=a.summarizeLocal(30);
assert.equal(stats.kinds.find(x=>x.kind==='view').count,1);
assert.equal(stats.kinds.find(x=>x.kind==='success').count,1);
assert.equal(stats.tools[0].inputBytes,1024);
assert.equal(posts.length,2);
for(let i=0;i<68;i++)a.recordEvent('open','video-frames');
await a.flushPending();
assert.equal(posts.length,70);
const before=posts.length;
a.setSharingEnabled(false);a.recordEvent('error','video-frames');await a.flushPending();
assert.equal(posts.length,before);
assert.equal(a.localEvents().length,72);
assert.equal(JSON.parse(a.exportLocalEvents()).events.length,72);
a.clearLocalEvents();
assert.equal(a.localEvents().length,0);
assert.equal(JSON.parse(memory.get('lokit:analytics:queue:v1')).length,0);
// Календарные периоды: событие вчера утром считается внутри семидневного окна.
const today=new Date();today.setUTCHours(0,0,0,0);
const testEvents=[{id:'past',ts:new Date(today.getTime()-6*86400000+1000).toISOString(),kind:'success',tool:'video-trim',durationMs:1500,inputBytes:200,outputBytes:100},
  {id:'too-old',ts:new Date(today.getTime()-7*86400000+1000).toISOString(),kind:'error',tool:'video-trim',durationMs:200}];
memory.set('lokit:analytics:v1',JSON.stringify(testEvents));
assert.equal(a.summarizeLocal(7).kinds.find(x=>x.kind==='success').count,1);
assert.equal(a.summarizeLocal(7).kinds.some(x=>x.kind==='error'),false);
assert.equal(a.summarizeLocal(30).kinds.find(x=>x.kind==='error').count,1);
console.log('Analytics tests: UTC date windows, opt-in, local summaries, bytes, batching, privacy opt-out, delete, JSON export — PASS');
