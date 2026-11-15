import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const scope='https://example.test/lokit/';
function worker({openError=false,matchError=false,putError=false,offline=false,cached=false}={}){
 const handlers={};let writes=0,requests=0;
 const cache={
  async match(){if(matchError)throw Error('cache read');return cached?new Response('cached'):undefined;},
  async put(){writes++;if(putError)throw Error('quota');}
 };
 vm.runInNewContext(source,{
  self:{registration:{scope},location:{origin:new URL(scope).origin},addEventListener(name,handler){handlers[name]=handler;}},
  URL,Response,Set,Promise,
  caches:{async open(){if(openError)throw Error('storage denied');return cache;}},
  async fetch(){requests++;if(offline)throw Error('offline');return new Response('network');}
 });
 return {async request(path,destination='script'){
   let response;
   handlers.fetch({request:{url:new URL(path,scope).href,method:'GET',destination,mode:destination==='document'?'navigate':'cors'},respondWith(promise){response=promise;}});
   assert.ok(response,'SW intercepts '+path);
   return response;
 },get writes(){return writes;},get requests(){return requests;}};
}
for(const path of ['js/app.js','assets/codecs/ffmpeg-core-0.12.10.wasm','pdfcraft/','craft-apps/photocraft/']){
 for(const failure of [{openError:true},{matchError:true,putError:true},{putError:true}]){
  const sw=worker(failure);
  const response=await sw.request(path);
  assert.equal(response.status,200,path);
  assert.equal(await response.text(),'network',path);
 }
 const saved=worker({cached:true,offline:true});
 assert.equal(await (await saved.request(path)).text(),'cached',path+' offline fallback');
}
const fresh=worker({cached:true,putError:true});
assert.equal(await (await fresh.request('js/app.js')).text(),'network','Do not replace fresh code with stale cached code after quota error');
for(const path of ['pdfcraft/file.wasm?lokit-pdfcraft-prefetch=1','craft-apps/photocraft/file.wasm?lokit-craft-prefetch=1']){
 const sw=worker();assert.equal(await (await sw.request(path)).text(),'network');
 assert.equal(sw.writes,0,'Prefetch keeps a single cache writer');
}
console.log('PASS SW: blocked storage, read/write failure, fresh scripts, offline fallback and single-writer prefetch');
