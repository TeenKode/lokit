import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tools} from '../js/tools.js';
import {
  checkedAssets,prepareCraftAssets,cacheNameFor,CRAFT_PREFETCH
} from '../js/craft-loader.js';

const pins=JSON.parse(readFileSync(new URL('../artcraft-releases.json',import.meta.url),'utf8'));
assert.equal(pins.apps.length,15);
assert.equal(new Set(pins.apps.map(x=>x.name)).size,15);
for(const app of pins.apps){
  assert.match(app.sha256,/^[a-f0-9]{64}$/);
  assert.match(app.version,/^\d+\.\d+\.\d+$/);
  assert.ok(app.bytes>2000000);
  const tool=tools.find(x=>x.id==='artcraft-'+app.name);
  assert.ok(tool,'Missing Lokit tool '+app.name);
  assert.equal(tool.href,'./craft.html?app='+app.name);
  assert.equal(tool.title,app.title);
  assert.equal(tool.category,app.category);
}
assert.equal(tools.length,40);
const root=new URL('https://example.test/lokit/craft-apps/photocraft/');
const resources={
 'index.html':'<!doctype html><title>PhotoCraft</title>',
 'app_bg.wasm':new Uint8Array([0,97,115,109,1,2,3,4])
};
const files=Object.entries(resources).map(([path,body])=>({
  path:'./'+path,bytes:typeof body==='string'?new TextEncoder().encode(body).byteLength:body.byteLength
}));
const manifest={schema:1,name:'photocraft',version:'0.23.1',assets:files,totalBytes:files.reduce((n,a)=>n+a.bytes,0)};
resources['lokit-assets.json']=JSON.stringify(manifest);
const {assets,total}=checkedAssets(manifest,'photocraft','0.23.1',root);
assert.equal(assets.length,2);
assert.equal(total,manifest.totalBytes);
assert.throws(()=>checkedAssets({...manifest,assets:[{path:'./../escape.wasm',bytes:2},files[0]]},'photocraft','0.23.1',root),/Некорректный/);
assert.throws(()=>checkedAssets({...manifest,totalBytes:12345},'photocraft','0.23.1',root),/размер/);
const entries=new Map();
let puts=0,failPut=false,failFetchOnce=false;
const cache={
 async keys(){return [...entries.keys()];},
 async delete(url){return entries.delete(String(url));},
 async match(url){return entries.get(String(url))?.clone();},
 async put(url,response){
   if(failPut && String(url).endsWith('.wasm'))throw new DOMException('Storage full','QuotaExceededError');
   const bytes=await response.arrayBuffer();
   entries.set(String(url),new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||''}}));
   puts++;
 }
};
const cacheStorage={async open(key){assert.equal(key,cacheNameFor('photocraft'));return cache;}};
let downloads=0,misses=0;
async function fetcher(url,options){
  const u=new URL(url);
  assert.equal(u.searchParams.get(CRAFT_PREFETCH),'1');
  assert.equal(options.cache,'no-store');
  const path=u.pathname.slice(root.pathname.length);
  downloads++;
  if(path==='app_bg.wasm' && failFetchOnce){failFetchOnce=false;misses++;throw new Error('connection interrupted');}
  if(!Object.hasOwn(resources,path))return new Response('Not found',{status:404});
  const type=path.endsWith('.wasm')?'application/wasm':'application/octet-stream';
  return new Response(resources[path],{headers:{'Content-Type':type}});
}
const history=[];
const first=await prepareCraftAssets({
  baseURL:root.href,app:'photocraft',version:'0.23.1',
  fetcher,cacheStorage,concurrency:2,onProgress:x=>history.push(x)
});
assert.equal(first.assets,2);
assert.equal(first.reused,0);
assert.equal(first.totalBytes,total);
assert.equal(entries.size,3,'two assets + manifest cached');
assert.ok(history.some(x=>x.percent>0&&x.percent<100),'real intermediate byte progress');
assert.equal(history.at(-1).percent,100);
assert.equal((await (await cache.match(root+'app_bg.wasm')).arrayBuffer()).byteLength,8);
const oldDownloads=downloads;
const second=await prepareCraftAssets({
  baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage
});
assert.equal(second.reused,2);
assert.equal(downloads,oldDownloads+1,'Only refresh the small manifest when cached');
entries.delete(root+'app_bg.wasm');
failFetchOnce=true;
await prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage});
assert.equal(misses,1,'Interrupted network request should retry');
assert.equal(entries.size,3);
entries.delete(root+'app_bg.wasm');
failPut=true;
await assert.rejects(
  prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage}),
  /app_bg\.wasm.*Недостаточно места/
);
assert.ok(entries.has(root+'index.html'),'Stored assets survive a failed Cache.put');
failPut=false;
await prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage});
assert.equal(entries.size,3);
console.log('ArtCraft suite: 15 catalog entries, manifests, real progress, cache reuse, retry, offline and quota failures — PASS');

// A failed worker must stop a sibling blocked in a response body, preserve the
// original actionable error, and leave queued files for the next attempt.
const extra={path:'./later.js',bytes:2};
const parallelManifest={...manifest,assets:[...files,extra],totalBytes:total+2};
const parallelEntries=new Map();
let bodyCancelled=false,streamStarted=false,assetRequests=[];
const parallelCache={
 async keys(){return [...parallelEntries.keys()];},
 async delete(url){return parallelEntries.delete(String(url));},
 async match(url){return parallelEntries.get(String(url))?.clone();},
 async put(url,response){
   if(String(url).endsWith('.wasm'))throw new DOMException('full','QuotaExceededError');
   parallelEntries.set(String(url),response.clone());
 }
};
const parallelStorage={async open(){return parallelCache;}};
const parallelProgress=[];
const parallelRun=prepareCraftAssets({
 baseURL:root.href,app:'photocraft',version:'0.23.1',cacheStorage:parallelStorage,
 onProgress:info=>parallelProgress.push(info),
 async fetcher(url,{signal}){
   const path=new URL(url).pathname.slice(root.pathname.length);
   if(path==='lokit-assets.json')return new Response(JSON.stringify(parallelManifest));
   assetRequests.push(path);
   if(path==='index.html')return new Response(new ReadableStream({
     start(){streamStarted=true;},
     cancel(){bodyCancelled=true;}
   }));
   assert.ok(streamStarted);
   assert.equal(signal.aborted,false);
   return new Response(resources[path]||'ok');
 }
});
await assert.rejects(parallelRun,/app_bg\.wasm.*Недостаточно места/);
assert.equal(bodyCancelled,true,'Failed cache write cancels a sibling response body');
assert.deepEqual(assetRequests,['index.html','app_bg.wasm'],'Do not start queued assets after failure');
assert.equal(parallelProgress.at(-1).stage,'error');
assert.ok(!parallelProgress.some(x=>x.stage==='complete'));

// Caller cancellation unblocks a pending read even with a custom fetcher that
// does not itself wire the signal to its response stream.
const caller=new AbortController();
let readStarted;
const started=new Promise(resolve=>{readStarted=resolve;});
let cancelCalls=0;
const cancelledProgress=[];
const cancelledRun=prepareCraftAssets({
 baseURL:root.href,app:'photocraft',version:'0.23.1',signal:caller.signal,
 cacheStorage:{async open(){return {async match(){},async put(){},async keys(){return [];},async delete(){}};}},
 onProgress:info=>cancelledProgress.push(info),
 async fetcher(url){
   if(new URL(url).pathname.endsWith('lokit-assets.json'))return new Response(resources['lokit-assets.json']);
   return new Response(new ReadableStream({
     start(){readStarted();},cancel(){cancelCalls++;}
   }));
 }
});
await started;
caller.abort();
await assert.rejects(cancelledRun,/отменена/);
assert.ok(cancelCalls>0);
assert.ok(!cancelledProgress.some(x=>x.stage==='complete'));
let preAbortedRequests=0;
await assert.rejects(prepareCraftAssets({signal:caller.signal,fetcher(){preAbortedRequests++;}}),{name:'AbortError'});
assert.equal(preAbortedRequests,0);

// Non-finite concurrency previously spawned zero workers and falsely reported
// a complete offline copy without saving any of its assets.
for(const concurrency of [NaN,Infinity,-Infinity]){
 entries.clear();
 const result=await prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage,concurrency});
 assert.equal(result.reused,0);
 assert.equal(entries.size,3);
}
console.log('ArtCraft cancellation: fail-fast siblings, blocked stream cleanup, caller abort and finite concurrency — PASS');

// An update must not reuse assets from the previous release, even at equal size.
const oldManifest={...manifest,version:'0.22.0'};
entries.set(root+'lokit-assets.json',new Response(JSON.stringify(oldManifest)));
entries.set(root+'app_bg.wasm',new Response(new Uint8Array(8).fill(9)));
const updated=await prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage});
assert.equal(updated.reused,0);
assert.deepEqual(new Uint8Array(await entries.get(root+'app_bg.wasm').clone().arrayBuffer()),resources['app_bg.wasm']);
// Invalid remote metadata must leave the last valid offline copy untouched.
const validManifest=resources['lokit-assets.json'];
resources['lokit-assets.json']=JSON.stringify({...manifest,totalBytes:1});
await assert.rejects(prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher,cacheStorage}),/размер/);
assert.equal((await entries.get(root+'lokit-assets.json').clone().json()).totalBytes,total);
resources['lokit-assets.json']=validManifest;
const offline=await prepareCraftAssets({baseURL:root.href,app:'photocraft',version:'0.23.1',fetcher:async()=>{throw Error('offline');},cacheStorage});
assert.equal(offline.reused,2);
console.log('ArtCraft updates: discard previous release resources, validate before overwrite, offline reuse — PASS');
