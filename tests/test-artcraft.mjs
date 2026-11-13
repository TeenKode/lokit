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
