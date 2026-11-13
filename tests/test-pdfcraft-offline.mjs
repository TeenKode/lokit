import assert from 'node:assert/strict';
import {savePdfCraftOffline,PDFCRAFT_VERSION,PDFCRAFT_OFFLINE_CACHE,PDFCRAFT_PREFETCH_PARAM} from '../js/pdf-offline.js';

const root='https://example.test/lokit/pdfcraft/';
const files=['./index.html','./module.wasm','./models/ocr.onnx','./offline-assets.json'];
const resources={
  'index.html':'<canvas id="pdfcraft"></canvas>',
  'module.wasm':new Uint8Array([0,97,115,109,1,0,0,0]),
  'models/ocr.onnx':new Uint8Array([1,2,3,4]),
  'offline-assets.json':JSON.stringify({version:PDFCRAFT_VERSION,files})
};
const data=new Map();
let puts=0,failedPut=false,failOnce=false;
const cache={
  async match(url){return data.get(String(url))?.clone();},
  async put(url,response){
    if(failedPut && String(url).endsWith('models/ocr.onnx'))throw new TypeError('Cache.put() encountered a network error');
    const bytes=await response.arrayBuffer();
    assert.ok(bytes.byteLength>0);
    data.set(String(url),new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||''}}));
    puts++;
  }
};
const cacheStorage={async open(name){assert.equal(name,PDFCRAFT_OFFLINE_CACHE);return cache;}};
const calls=[];
async function fetcher(raw,options){
  const u=new URL(raw);
  assert.equal(u.searchParams.get(PDFCRAFT_PREFETCH_PARAM),'1','Prefetch must bypass SW');
  assert.equal(options.cache,'no-store');
  const path=u.pathname.slice(new URL(root).pathname.length);
  calls.push(path);
  if(failOnce && path==='module.wasm'){failOnce=false;throw new Error('connection lost');}
  if(!Object.hasOwn(resources,path))return new Response('Not found',{status:404});
  const type=path.endsWith('.wasm')?'application/wasm':path.endsWith('.html')?'text/html':'application/octet-stream';
  return new Response(resources[path],{headers:{'Content-Type':type}});
}
const progress=[];
const first=await savePdfCraftOffline({baseURL:root,fetcher,cacheStorage,progress:p=>progress.push(p)});
assert.equal(first.total,4);
assert.equal(first.reused,0);
assert.equal(first.done,4);
assert.equal(puts,4);
assert.equal(progress.length,4);
assert.equal(data.size,4);
assert.equal((await (await cache.match(root+'module.wasm')).arrayBuffer()).byteLength,8);

const fetched=calls.length;
const second=await savePdfCraftOffline({baseURL:root,fetcher,cacheStorage});
assert.equal(second.reused,4);
assert.equal(puts,4,'Second run must not write cached data again');
assert.equal(calls.length,fetched+1,'Second run only refreshes manifest');

data.delete(root+'module.wasm');
failOnce=true;
const third=await savePdfCraftOffline({baseURL:root,fetcher,cacheStorage});
assert.equal(third.reused,3);
assert.equal(data.size,4);
assert.equal(calls.filter(x=>x==='module.wasm').length,3,'Interrupted fetch should retry');
data.delete(root+'models/ocr.onnx');
failedPut=true;
await assert.rejects(savePdfCraftOffline({baseURL:root,fetcher,cacheStorage}),
  /Сохранение «\.\/models\/ocr.onnx»: Cache.put\(\) encountered a network error/);
assert.equal(data.size,3,'Failed item must not delete cached successes');
failedPut=false;
await savePdfCraftOffline({baseURL:root,fetcher,cacheStorage});
assert.equal(data.size,4,'Next click resumes after failed item');

resources['offline-assets.json']=JSON.stringify({version:PDFCRAFT_VERSION,files:['./../escape','./index.html']});
await assert.rejects(savePdfCraftOffline({baseURL:root,fetcher,cacheStorage}),
  /Недопустимый путь/);
resources['offline-assets.json']=JSON.stringify({version:PDFCRAFT_VERSION,files});
console.log('PDFCraft offline: single-writer, resume, retry, named Cache.put errors and safe paths — PASS');
