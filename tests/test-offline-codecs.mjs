import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEPENDENCIES,CODEC_NAMES,fetchCodecBlob,getCodecStatus,downloadAllCodecs,removeOfflineCodecs} from '../js/codec-assets.js';
assert.equal(CODEC_NAMES.length,3);
assert(Object.values(DEPENDENCIES).every(url=>url.startsWith('file:') || url.startsWith('https:') || url.startsWith('http:')));
assert(Object.values(DEPENDENCIES).every(url=>!url.includes('cdn.jsdelivr.net')));
const originalCaches=globalThis.caches,originalFetch=globalThis.fetch;
const map = new Map();
let calls=0;
globalThis.caches={open:async()=>({
  match:async url=>map.get(url)?.clone(),
  put:async(url,response)=>{map.set(url,response.clone());}
}),delete:async()=>{map.clear();return true;}};
globalThis.fetch=async(url)=>{calls++;return new Response(new Uint8Array([1,2,3]),{status:200,headers:{'Content-Type':'application/octet-stream'}});};
try{
  const a=await getCodecStatus();
  assert.equal(a.complete,false);
  const seen=[];
  await downloadAllCodecs({onProgress:x=>seen.push(x)});
  assert.equal((await getCodecStatus()).complete,true);
  assert.equal(calls,3,'Only three local requests');
  const blob=await fetchCodecBlob(DEPENDENCIES.ffmpegWasm);
  assert.equal(blob.size,3);
  assert.equal(calls,3,'Cached codec should not require another request');
  assert.equal(seen.at(-1).completed,3);
  await removeOfflineCodecs();
  assert.equal((await getCodecStatus()).complete,false);
  const abort=new AbortController();abort.abort();
  await assert.rejects(downloadAllCodecs({signal:abort.signal}),{name:'AbortError'});
  await assert.rejects(fetchCodecBlob('https://example.org/evil.js'),/Неизвестный/);
  // Storage can be blocked even when CacheStorage exists (private mode/policy).
  // Ordinary online codec fetches must not fail with the storage error.
  globalThis.caches={open:async()=>{throw new DOMException('Storage blocked','SecurityError');}};
  const beforeOnline=calls;
  const online=await fetchCodecBlob(DEPENDENCIES.ffmpegCore);
  assert.equal(online.size,3);
  assert.equal(calls,beforeOnline+1,'Online codec fetch works when cache.open rejects');
  assert.deepEqual(await getCodecStatus(),{supported:false,cached:[],missing:[...CODEC_NAMES],complete:false});
  await assert.rejects(downloadAllCodecs(),/офлайн-хранилище/,'Offline prefetch must report unavailable storage');
}finally{globalThis.caches=originalCaches;globalThis.fetch=originalFetch;}
const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
assert(sw.includes('lokit-optional-codecs-v2'));
assert(sw.includes('assets/codecs/'));
const page=readFileSync(new URL('../about.html',import.meta.url),'utf8');
assert(page.includes('offline-codecs-download'));
assert(!/https:\/\/cdn\.jsdelivr\.net/.test(page));
console.log('Same-origin optional codecs, prefetch, offline cache, purge, abort and CSP — PASS');
