// Generic, byte-accurate offline downloader for original same-origin ArtCraft apps.
// Requests are fetched once, then written from completed streams to Cache Storage.
export const CRAFT_CACHE_PREFIX='lokit-craft-v1-';
export const CRAFT_PREFETCH='lokit-craft-prefetch';
const MAX_ASSETS=10000;
const MAX_BYTES=400*1024*1024;

export function cacheNameFor(app){
  if(!/^[a-z0-9-]{2,50}$/.test(app))throw new Error('Некорректное имя приложения.');
  return CRAFT_CACHE_PREFIX+app;
}
export function checkedAssets(manifest,app,version,root){
  if(manifest?.schema!==1||manifest?.name!==app||manifest?.version!==version
     ||!Array.isArray(manifest.assets)||manifest.assets.length<2
     ||manifest.assets.length>MAX_ASSETS)
    throw new Error('Отсутствует корректный список файлов приложения.');
  const visited=new Set(),assets=[];
  let total=0;
  for(const file of manifest.assets){
    const path=file?.path;
    if(typeof path!=='string'||!path.startsWith('./')||/[\\?#\u0000-\u001f]/.test(path)
       ||path.slice(2).split('/').some(segment=>!segment||segment==='.'||segment==='..')
       ||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_BYTES)
      throw new Error('Некорректный файл или размер в списке ресурсов.');
    const url=new URL(path,root);
    if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname)||visited.has(url.href))
      throw new Error('Файл вне папки приложения либо повторяющийся адрес.');
    visited.add(url.href);
    total+=file.bytes;
    if(total>MAX_BYTES)throw new Error('Размер приложения превышает лимит.');
    assets.push({path,url:url.href,bytes:file.bytes});
  }
  if(!visited.has(new URL('index.html',root).href)||!manifest.assets.some(x=>x.path.endsWith('.wasm')))
    throw new Error('Нет HTML или WebAssembly-движка приложения.');
  if(total!==manifest.totalBytes)throw new Error('Не совпадает размер ресурсов в списке.');
  return {assets,total};
}
function fetchURL(url){
  const tagged=new URL(url);
  tagged.searchParams.set(CRAFT_PREFETCH,'1');
  return tagged.href;
}
function showError(error){
  if(error?.name==='QuotaExceededError')
    return 'Недостаточно места в памяти браузера; можно открыть редактор без офлайн-сохранения.';
  if(error?.name==='AbortError')return 'Загрузка отменена.';
  return error instanceof Error?error.message:String(error);
}
async function fetchComplete(url,{fetcher,signal,update=()=>{},attempts=2}){
  let last;
  for(let attempt=0;attempt<attempts;attempt++){
    update(0);
    try{
      const response=await fetcher(fetchURL(url),{cache:'no-store',signal});
      if(!response?.ok||response.type==='opaque')
        throw new Error('HTTP '+(response?.status??'без ответа'));
      const contentType=response.headers.get('Content-Type')||'application/octet-stream';
      const chunks=[];
      let count=0;
      if(response.body?.getReader){
        const reader=response.body.getReader();
        try{
          for(;;){
            const {value,done}=await reader.read();
            if(done)break;
            count+=value.byteLength;
            if(count>MAX_BYTES)throw new Error('Файл превышает максимальный размер');
            chunks.push(value);
            update(count);
          }
        }finally{reader.releaseLock();}
      }else{
        const data=await response.arrayBuffer();
        count=data.byteLength;
        chunks.push(data);
        update(count);
      }
      return {chunks,count,contentType};
    }catch(error){
      last=error;
      if(signal?.aborted)throw error;
    }
  }
  throw last;
}
function blobResponse(file){
  return new Response(new Blob(file.chunks,{type:file.contentType}),{
    headers:{'Content-Type':file.contentType}
  });
}

/** Download, display byte-level progress, cache and retry an entire web app.
 * The caller can abort without deleting previously saved assets.
 */
export async function prepareCraftAssets({
  baseURL,app,version,fetcher=fetch,cacheStorage=caches,signal,
  onProgress=()=>{},storageManager=null,concurrency=2
}={}){
  const root=new URL(baseURL);
  if(!/^https?:$/.test(root.protocol)||!root.pathname.endsWith('/'+app+'/'))
    throw new Error('Недопустимый адрес приложения.');
  const cache=await cacheStorage.open(cacheNameFor(app));
  try{await storageManager?.persist?.();}catch{/* Storage permission is optional. */}
  const manifestURL=new URL('lokit-assets.json',root);
  let raw;
  try{
    raw=await fetchComplete(manifestURL.href,{fetcher,signal});
    if(raw.count>2*1024*1024)throw new Error('Список файлов слишком большой.');
    await cache.put(manifestURL.href,blobResponse(raw));
  }catch(error){
    if(signal?.aborted)throw error;
    const old=await cache.match(manifestURL.href);
    if(!old?.ok)throw new Error('Невозможно загрузить список файлов: '+showError(error));
    raw={chunks:[await old.arrayBuffer()]};
  }
  let manifest;
  try{manifest=JSON.parse(await new Blob(raw.chunks).text());}
  catch{throw new Error('Невозможно прочитать список файлов.');}
  const {assets,total}=checkedAssets(manifest,app,version,root);
  const current=new Map();
  let completed=0,completedFiles=0,reused=0;
  function report(stage,file){
    const inflight=[...current.values()].reduce((a,b)=>a+b,0);
    onProgress({
      stage,file,loaded:Math.min(total,completed+inflight),total,
      percent:total?Math.min(99,Math.floor((completed+inflight)/total*100)):0,
      done:completedFiles,count:assets.length,reused
    });
  }
  report('preparing','');
  let index=0;
  async function worker(){
    while(index<assets.length){
      if(signal?.aborted)throw new DOMException('Загрузка отменена','AbortError');
      const item=assets[index++];
      let existing;
      try{existing=await cache.match(item.url);}catch{/* Treat as missing. */}
      if(existing?.ok){
        completed+=item.bytes;
        completedFiles++;
        reused++;
        report('cached',item.path);
        continue;
      }
      let file;
      try{
        file=await fetchComplete(item.url,{
          fetcher,signal,update:bytes=>{
            current.set(item.url,Math.min(bytes,item.bytes));
            report('downloading',item.path);
          }
        });
        if(file.count!==item.bytes)
          throw new Error('Размер полученного файла не совпадает: '+file.count+' вместо '+item.bytes);
        if(/\.(?:wasm|js|onnx)$/i.test(item.path)&&/text\/html/i.test(file.contentType))
          throw new Error('Сервер вернул HTML вместо файла');
      }catch(error){
        current.delete(item.url);
        throw new Error('Ошибка загрузки '+item.path+': '+showError(error));
      }
      try{
        await cache.put(item.url,blobResponse(file));
      }catch(error){
        current.delete(item.url);
        throw new Error('Ошибка сохранения '+item.path+': '+showError(error));
      }
      current.delete(item.url);
      completed+=item.bytes;
      completedFiles++;
      report('saved',item.path);
    }
  }
  try{
    // Promise.all rejects immediately, so avoid leaving other workers running.
    const workers=Array.from({length:Math.min(3,Math.max(1,Math.floor(concurrency)))},()=>worker());
    const settled=await Promise.allSettled(workers);
    const failed=settled.find(result=>result.status==='rejected');
    if(failed)throw failed.reason;
  }catch(error){
    report('error',showError(error));
    throw error;
  }
  onProgress({
    stage:'complete',file:'',loaded:total,total,percent:100,
    done:assets.length,count:assets.length,reused
  });
  return {assets:assets.length,reused,totalBytes:total};
}
