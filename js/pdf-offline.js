// PdfCraft offline prefetch: one writer only, with retry and resumable caching.
export const PDFCRAFT_VERSION='0.21.1';
export const PDFCRAFT_OFFLINE_CACHE='lokit-pdfcraft-v0.21.1-r2';
export const PDFCRAFT_PREFETCH_PARAM='lokit-pdfcraft-prefetch';
const MAX_FILES=1000;
const MAX_BYTES=128*1024*1024;

function describe(error){
  if(error?.name==='QuotaExceededError')
    return 'Недостаточно места в хранилище браузера. Освободите место или разрешите постоянное хранение.';
  return error instanceof Error?error.message:String(error);
}
function tagged(url){
  const parsed=new URL(url);
  parsed.searchParams.set(PDFCRAFT_PREFETCH_PARAM,'1');
  return parsed.href;
}
async function retrieve(url,fetcher){
  let last;
  for(let i=0;i<2;i++){
    try{
      const response=await fetcher(tagged(url),{cache:'no-store'});
      if(!response?.ok||response.type==='opaque')
        throw new Error('HTTP '+(response?.status??'нет ответа'));
      // Consume the network stream fully before Cache Storage writes anything.
      const bytes=await response.arrayBuffer();
      if(!bytes.byteLength||bytes.byteLength>MAX_BYTES)
        throw new Error('Пустой или слишком большой ресурс');
      return {bytes,contentType:response.headers.get('Content-Type')||'application/octet-stream'};
    }catch(error){last=error;}
  }
  throw last;
}
function checkedFiles(manifest,root,version){
  if(manifest?.version!==version||!Array.isArray(manifest?.files)
     ||!manifest.files.length||manifest.files.length>MAX_FILES)
    throw new Error('Неверная версия PDFCraft или список офлайн-файлов.');
  const seen=new Set(),files=[];
  for(const path of manifest.files){
    if(typeof path!=='string'||!/^\.\/[a-zA-Z0-9_./-]+$/.test(path))
      throw new Error('Недопустимое имя файла в списке автономной версии.');
    if(path.slice(2).split('/').some(part=>!part||part==='.'||part==='..'))
      throw new Error('Недопустимый путь в списке автономной версии.');
    const url=new URL(path,root);
    if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname)||seen.has(url.href))
      throw new Error('Некорректный или повторяющийся адрес офлайн-файла.');
    seen.add(url.href);
    files.push({path,url:url.href});
  }
  if(!seen.has(new URL('index.html',root).href))
    throw new Error('Отсутствует стартовая страница PDFCraft.');
  return files;
}
export async function savePdfCraftOffline({
  baseURL,fetcher=fetch,cacheStorage=caches,
  cacheName=PDFCRAFT_OFFLINE_CACHE,version=PDFCRAFT_VERSION,
  progress=()=>{},storageManager=null
}={}){
  const root=new URL(baseURL);
  if(!/^https?:$/.test(root.protocol))throw new Error('Неверный адрес PDF-редактора.');
  const cache=await cacheStorage.open(cacheName);
  try{await storageManager?.persist?.();}catch{/* Optional permission. */}
  const manifestURL=new URL('offline-assets.json',root);
  let manifestBytes;
  try{manifestBytes=(await retrieve(manifestURL.href,fetcher)).bytes;}
  catch(error){
    const cached=await cache.match(manifestURL.href);
    if(!cached?.ok)throw new Error('Загрузка списка файлов «offline-assets.json»: '+describe(error));
    manifestBytes=await cached.arrayBuffer();
  }
  let manifest;
  try{manifest=JSON.parse(new TextDecoder().decode(manifestBytes));}
  catch{throw new Error('Не удалось прочитать список ресурсов PDFCraft.');}
  const files=checkedFiles(manifest,root,version);
  let done=0,reused=0,downloadedBytes=0;
  for(const item of files){
    let saved;
    try{saved=await cache.match(item.url);}catch{saved=null;}
    if(saved?.ok){
      reused++;
    }else{
      let result;
      try{result=await retrieve(item.url,fetcher);}
      catch(error){throw new Error('Загрузка «'+item.path+'»: '+describe(error));}
      if(/\.(?:wasm|onnx|js)$/i.test(item.path)&&/text\/html/i.test(result.contentType))
        throw new Error('Вместо файла «'+item.path+'» сервер вернул HTML.');
      try{
        // Cache.put sees an independent memory Blob, not a live network stream.
        const body=new Blob([result.bytes],{type:result.contentType});
        await cache.put(item.url,new Response(body,{headers:{'Content-Type':result.contentType}}));
        if(!(await cache.match(item.url))?.ok)
          throw new Error('Ресурс отсутствует в кэше после записи');
      }catch(error){throw new Error('Сохранение «'+item.path+'»: '+describe(error));}
      downloadedBytes+=result.bytes.byteLength;
    }
    done++;
    progress({done,total:files.length,reused,file:item.path});
  }
  return {done,total:files.length,reused,downloadedBytes};
}
