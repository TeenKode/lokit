/** ZIP32 (STORE) writer. No CDN, no compression of already-compressed media.
 * Reads each Blob in bounded chunks to calculate CRC32 and reuses the Blob as a part.
 */
const utf8=new TextEncoder();
const TABLE=Uint32Array.from({length:256},(_,n)=>{
  for(let i=0;i<8;i++)n=(n&1)?(0xedb88320^(n>>>1)):(n>>>1);
  return n>>>0;
});
const MAX_ZIP_SIZE=0xffffffff;
const abort=()=>new DOMException('Создание ZIP отменено','AbortError');
export function safeZipName(name){
  const cleaned=String(name||'result.bin').replace(/[\\/\x00-\x1f\x7f]/g,'_').replace(/^\.+/,'').trim();
  return cleaned||'result.bin';
}
export function uniqueZipEntries(entries){
  const counts=new Set();
  // Track the next available suffix per original name to avoid rescanning
  // thousands of occupied suffixes for large batches of identical filenames.
  const nextSuffix=new Map();
  return entries.map((entry)=>{
    if(!(entry?.blob instanceof Blob))throw new TypeError('Для ZIP нужен результат Blob.');
    const name=safeZipName(entry.name),dot=name.lastIndexOf('.');
    const base=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
    const key=name.toLocaleLowerCase('en');
    let candidate=name;
    if(counts.has(key)){
      let n=nextSuffix.get(key)??2;
      do {candidate=`${base} (${n++})${ext}`;}
      while(counts.has(candidate.toLocaleLowerCase('en')));
      nextSuffix.set(key,n);
    }
    counts.add(candidate.toLocaleLowerCase('en'));
    return {name:candidate,blob:entry.blob};
  });
}
function view(n){return new DataView(new ArrayBuffer(n));}
function u8(v){return new Uint8Array(v.buffer);}
function validateSize(total){if(total>MAX_ZIP_SIZE)throw new RangeError('Размер ZIP превышает 4 ГБ. Скачайте готовые файлы по отдельности.');}
export async function createZip(entries,{signal,onProgress=()=>{},chunkSize=1024*1024}={}){
  if(!Array.isArray(entries)||!entries.length)throw new Error('Нет готовых файлов для ZIP-архива.');
  if(!Number.isSafeInteger(chunkSize)||chunkSize<1024)throw new RangeError('Неверный размер блока.');
  const files=uniqueZipEntries(entries);
  const totalBytes=files.reduce((n,f)=>n+f.blob.size,0);
  if(!Number.isSafeInteger(totalBytes))throw new RangeError('Не удалось создать ZIP: слишком большой размер.');
  let estimate=22;
  for(const f of files){
    const encoded=utf8.encode(f.name);
    if(encoded.length>65535)throw new RangeError('Не удалось создать ZIP: слишком длинное имя файла.');
    if(f.blob.size>MAX_ZIP_SIZE)throw new RangeError('Этот файл слишком велик для ZIP-архива.');
    estimate+=f.blob.size+76+2*encoded.length;
  }
  if(files.length>65535)throw new RangeError('Не удалось создать ZIP: слишком много файлов.');
  validateSize(estimate);
  const parts=[],central=[];
  let offset=0,hashed=0;
  for(const file of files){
    if(signal?.aborted)throw abort();
    const name=utf8.encode(file.name);
    let crc=0xffffffff;
    for(let pos=0;pos<file.blob.size;pos+=chunkSize){
      if(signal?.aborted)throw abort();
      const block=new Uint8Array(await file.blob.slice(pos,Math.min(pos+chunkSize,file.blob.size)).arrayBuffer());
      for(let j=0;j<block.length;j++)crc=(TABLE[(crc^block[j])&255]^(crc>>>8))>>>0;
      hashed+=block.length;
      onProgress({bytes:hashed,totalBytes,percent:totalBytes?Math.round(hashed/totalBytes*100):100});
      // Allow cancellation and painting between chunks of large files.
      if((hashed/chunkSize)%8===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    crc=(crc^0xffffffff)>>>0;
    const local=view(30);
    local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x0800,true);
    local.setUint16(8,0,true);local.setUint32(10,0,true);local.setUint32(14,crc,true);
    local.setUint32(18,file.blob.size,true);local.setUint32(22,file.blob.size,true);
    local.setUint16(26,name.length,true);
    parts.push(u8(local),name,file.blob);
    const entry=view(46);
    entry.setUint32(0,0x02014b50,true);entry.setUint16(4,20,true);entry.setUint16(6,20,true);entry.setUint16(8,0x0800,true);
    entry.setUint16(10,0,true);entry.setUint32(12,0,true);entry.setUint32(16,crc,true);
    entry.setUint32(20,file.blob.size,true);entry.setUint32(24,file.blob.size,true);
    entry.setUint16(28,name.length,true);entry.setUint32(42,offset,true);
    central.push(u8(entry),name);
    offset+=30+name.length+file.blob.size;
  }
  if(signal?.aborted)throw abort();
  const centralSize=central.reduce((n,p)=>n+p.byteLength,0);
  validateSize(offset+centralSize+22);
  const end=view(22);
  end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);
  end.setUint16(10,files.length,true);end.setUint32(12,centralSize,true);end.setUint32(16,offset,true);
  onProgress({bytes:totalBytes,totalBytes,percent:100});
  return new Blob([...parts,...central,u8(end)],{type:'application/zip'});
}
