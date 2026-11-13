// Refresh offline navigation assets; preserve v0.8.5 bundled codec caches.
const CACHE='lokit-v0.8.5';
const FILES=[
  './','./index.html','./pdf.html','./craft.html','./analytics.html','./about.html','./batch.html','./style.css','./style-enhancements.css','./layout-compact.css','./sidebar.css','./glow.css','./batch.css','./manifest.webmanifest',
  './pdf.css','./js/pdf-page.js','./js/pdf-offline.js','./craft.css','./js/craft-loader.js','./js/craft-page.js','./artcraft-releases.json',
  './icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png',
  './js/app.js','./js/tools.js','./js/media.js','./js/analytics.js',
  './js/analytics-page.js','./js/background.js','./js/batch-queue.js','./js/batch-page.js','./js/zip.js','./js/editor.js','./js/edit-history.js','./js/multitrack.js','./js/subtitle-timeline.js','./js/precision-timeline.js','./js/render.js','./js/mp4-fast.js','./js/experimental-engines.js','./js/experimental-ffmpeg-worker.js','./js/codec-assets.js','./js/offline-codecs-page.js','./js/vendor/mp4-track-remux.js','./js/vendor/mp4-flatten.js','./js/vendor/mp4-copy-trim.js','./js/vendor/webm-copy-trim.js','./js/presets.js','./js/capabilities.js','./js/version.js',
  './js/vendor/trim-timeline.js','./js/vendor/subtitle-serializer.js','./js/vendor/waveform-preview.js'
];
// Heavy codecs remain lazy; keep them in a separate, explicitly removable cache.
const CODEC_CACHE='lokit-optional-codecs-v2';
const CODEC_PATHS=new Set([
  './assets/codecs/mediabunny-1.65.2.cjs',
  './assets/codecs/ffmpeg-core-0.12.10.js',
  './assets/codecs/ffmpeg-core-0.12.10.wasm'
].map(path=>new URL(path,self.registration.scope).pathname));
// The original PDFCraft web release is staged in Pages, not committed to Git.
const PDFCRAFT_CACHE='lokit-pdfcraft-v0.21.1-r2';
const PDFCRAFT_PATH=new URL("./pdfcraft/",self.registration.scope).pathname;
const CRAFT_PATH=new URL("./craft-apps/",self.registration.scope).pathname;
const CRAFT_CACHE_PREFIX="lokit-craft-v1-";
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>(key.startsWith('lokit-v')&&key!==CACHE)||(key.startsWith('lokit-optional-codecs-')&&key!==CODEC_CACHE)||(key.startsWith('lokit-pdfcraft-v')&&key!==PDFCRAFT_CACHE)).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
const files=new Set(FILES.map(path=>new URL(path,self.registration.scope).pathname));
self.addEventListener('fetch',event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  if(url.pathname.startsWith(PDFCRAFT_PATH)){
    // Prefetch has ONE cache writer: js/pdf-offline.js. Do not double-tee
    // network streams through the Service Worker for large WASM/OCR files.
    if(url.searchParams.has('lokit-pdfcraft-prefetch')){
      event.respondWith(fetch(req));
      return;
    }
    event.respondWith((async()=>{
      const cache=await caches.open(PDFCRAFT_CACHE);
      // The iframe uses /pdfcraft/ but prefetch includes /pdfcraft/index.html.
      const key=url.pathname===PDFCRAFT_PATH
        ?new URL('index.html',self.location.origin+PDFCRAFT_PATH).href
        :req;
      const cached=await cache.match(key,{ignoreSearch:true});
      if(cached)return cached;
      try{
        const response=await fetch(req);
        if(response.ok&&response.type!=='opaque'){
          try{await cache.put(key,response.clone());}catch{/* Storage quota or stream interruption. */}
        }
        return response;
      }catch{
        return new Response('PDFCraft не сохранён для работы без интернета.',{status:503});
      }
    })());
    return;
  }
  if(url.pathname.startsWith(CRAFT_PATH)){
    const rest=url.pathname.slice(CRAFT_PATH.length);
    const name=rest.split('/')[0];
    if(!/^[a-z0-9-]{2,50}$/.test(name))return;
    // The visible progress loader is the only writer while prefetching large
    // official WebAssembly bundles; no concurrent Cache.put stream clones.
    if(url.searchParams.has('lokit-craft-prefetch')){
      event.respondWith(fetch(req));
      return;
    }
    event.respondWith((async()=>{
      const cache=await caches.open(CRAFT_CACHE_PREFIX+name);
      const key=rest===name+'/'
        ?new URL('index.html',self.location.origin+url.pathname).href
        :req.url;
      const cached=await cache.match(key,{ignoreSearch:true});
      if(cached)return cached;
      try{
        const response=await fetch(req);
        if(response.ok&&response.type!=='opaque'){
          try{await cache.put(key,response.clone());}
          catch{/* Full storage or interrupted stream; still return response. */}
        }
        return response;
      }catch{
        return new Response('ArtCraft не сохранён для работы без интернета.',{status:503});
      }
    })());
    return;
  }
  if(CODEC_PATHS.has(url.pathname)){
    event.respondWith((async()=>{
      const cache=await caches.open(CODEC_CACHE);
      const saved=await cache.match(req);
      if(saved)return saved;
      try{
        const response=await fetch(req);
        if(response.ok&&!/text\/html/i.test(response.headers.get('Content-Type')||'')){
          try{await cache.put(req,response.clone());}catch{/* Quota may be exhausted. */}
        }
        return response;
      }catch{return new Response('Этот модуль не сохранён для работы офлайн.',{status:503});}
    })());
    return;
  }
  if(!files.has(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    // Страницы, настройки и скрипты обновляются при наличии сети.
    const fresh=['navigate','script','style','manifest'].includes(req.destination==='document'?'navigate':req.destination);
    if(fresh){
      try{
        const response=await fetch(req);
        if(response.ok){await cache.put(req,response.clone());return response;}
      }catch{}
    }
    return (await cache.match(req,{ignoreSearch:true}))
      ||(req.mode==='navigate'?await cache.match('./index.html'):null)
      ||fetch(req);
  })());
});
