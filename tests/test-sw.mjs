import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the real service worker fetch handler with a full/disabled CacheStorage.
const handlers = new Map();
const networkResponse = {ok:true,clone(){return this;}};
let networkOnline = true;
let cacheWrites = 0;
const cachedResponse = {ok:true,source:'cached'};
const cache = {
  async match(){return cachedResponse;},
  async put(){cacheWrites++;throw new Error('QuotaExceededError');}
};
const scope = 'https://example.test/lokit/';
const context = {
  URL,Set,Promise,Response,
  self:{
    registration:{scope},
    location:{origin:'https://example.test'},
    addEventListener(name,handler){handlers.set(name,handler);}
  },
  caches:{async open(){return cache;}},
  async fetch(){if(!networkOnline)throw new Error('offline');return networkResponse;}
};
vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),context,{filename:'sw.js'});
async function request(destination='script'){
  let responsePromise;
  handlers.get('fetch')({
    request:{url:scope+'js/app.js',method:'GET',destination,mode:'same-origin'},
    respondWith(value){responsePromise=Promise.resolve(value);}
  });
  assert(responsePromise,'The service worker must handle cached application scripts');
  return responsePromise;
}
assert.equal(await request(),networkResponse,'Cache write failure must not hide a successful network response');
assert.equal(cacheWrites,1);
networkOnline=false;
assert.equal(await request(),cachedResponse,'Offline requests must still use an existing cached copy');
console.log('PASS service worker: quota failure preserves online response and offline fallback');
