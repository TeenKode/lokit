const CACHE='lokit-v0.3.0';
const FILES=[
  './','./index.html','./analytics.html','./about.html','./style.css','./manifest.webmanifest',
  './icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png',
  './js/app.js','./js/tools.js','./js/media.js','./js/analytics.js',
  './js/analytics-page.js','./js/editor.js','./js/version.js',
  './js/vendor/trim-timeline.js','./js/vendor/subtitle-serializer.js','./js/vendor/waveform-preview.js'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('lokit-v')&&key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
const files=new Set(FILES.map(path=>new URL(path,self.registration.scope).pathname));
self.addEventListener('fetch',event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||!files.has(url.pathname))return;
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
