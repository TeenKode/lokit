/** Optional client-side engines. The ordinary Lokit pipeline never loads these. */
export const ENGINE_OPTIONS = ['classic','webcodecs','ffmpeg'];
export const EXPERIMENTAL_MODES = new Set(['convert','compress']);
export const DEPENDENCIES = Object.freeze({
  mediabunny: 'https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.cjs',
  ffmpegCore: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
  ffmpegWasm: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm'
});
const CACHE='lokit-optional-codecs-v1';
const MAX_FFMPEG_BYTES=90*1024*1024;
const abortError=()=>new DOMException('Операция отменена','AbortError');
export function experimentalEligibility({files,mode,options={}}={}){
  const engine=options.engine||'classic';
  if(engine==='classic')return {eligible:false,reason:'Проверенный экспорт по умолчанию'};
  if(!ENGINE_OPTIONS.includes(engine))return {eligible:false,reason:'Неизвестный движок'};
  if(!EXPERIMENTAL_MODES.has(mode)||!files?.length||files.length!==1)return {eligible:false,reason:'Инструмент не поддерживается экспериментальным движком'};
  if(!files[0]?.size)return {eligible:false,reason:'Файл пустой'};
  if(engine==='webcodecs'&&(typeof VideoEncoder==='undefined'||typeof VideoDecoder==='undefined'))
    return {eligible:false,reason:'WebCodecs не поддерживается браузером'};
  if(engine==='ffmpeg'&&files[0].size>MAX_FFMPEG_BYTES)
    return {eligible:false,reason:'FFmpeg/WASM ограничен файлами до 90 МиБ из-за расхода памяти'};
  return {eligible:true,engine};
}
function aborted(signal){if(signal?.aborted)throw abortError();}
// Only pin-listed public dependency URLs are allowed; no user-controlled URL or file content is sent.
async function cachedBlob(url,{signal,onDownload=()=>{}}={}){
  if(!Object.values(DEPENDENCIES).includes(url))throw new Error('Запрещённый источник библиотеки.');
  aborted(signal);
  const cache=typeof caches!=='undefined'?await caches.open(CACHE):null;
  let response=await cache?.match(url);
  if(!response){
    if(typeof navigator!=='undefined' && navigator.onLine===false)throw new Error('Для первого запуска нужен интернет, библиотека ещё не загружена.');
    response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache',signal});
    if(!response.ok||response.type==='opaque')throw new Error(`Не удалось загрузить библиотеку (${response.status}).`);
    // Store only successfully fetched assets, never cache user data.
    if(cache){try{await cache.put(url,response.clone());}catch{/* Cache quota may be limited. */}}
  }
  aborted(signal);
  onDownload(response.headers.get('Content-Length')||'');
  return response.blob();
}
let mediabunnyPromise;
async function loadMediabunny({signal,onProgress=()=>{}}={}){
  if(globalThis.Mediabunny)return globalThis.Mediabunny;
  if(typeof document==='undefined')throw new Error('Для WebCodecs требуется браузер.');
  mediabunnyPromise ||= (async()=>{
    onProgress({stage:'preparing',description:'Загрузка WebCodecs-мультиплексора (только первый запуск)…'});
    const downloaded=await cachedBlob(DEPENDENCIES.mediabunny,{signal});
    const url=URL.createObjectURL(new Blob([downloaded],{type:'text/javascript'}));
    try{
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=url;script.async=true;
        const clean=()=>{script.remove();signal?.removeEventListener('abort',onAbort);};
        const onAbort=()=>{clean();reject(abortError());};
        script.onload=()=>{clean();resolve();};script.onerror=()=>{clean();reject(new Error('Библиотека WebCodecs не запустилась.'));};
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted){onAbort();return;}
        document.head.append(script);
      });
      if(!globalThis.Mediabunny)throw new Error('Mediabunny не зарегистрировался.');
      return globalThis.Mediabunny;
    }finally{URL.revokeObjectURL(url);}
  })().catch(e=>{mediabunnyPromise=null;throw e;});
  return mediabunnyPromise;
}
export function scaledSize(width,height,resolution){
  const shortest=Math.min(width,height);
  const wanted=Number(resolution);
  if(resolution==='original'||!Number.isFinite(wanted)||wanted<=0||shortest<=wanted)
    return {width,height};
  const factor=wanted/shortest;
  const even=n=>Math.max(2,Math.round(n/2)*2);
  return {width:even(width*factor),height:even(height*factor)};
}
export async function runWebCodecs({file,mode,options,signal,onProgress=()=>{},mediabunny}={}){
  aborted(signal);
  const m=mediabunny||await loadMediabunny({signal,onProgress});
  const {Input,Output,Conversion,ALL_FORMATS,BlobSource,Mp4OutputFormat,BufferTarget,Quality}=m;
  if(![Input,Output,Conversion,ALL_FORMATS,BlobSource,Mp4OutputFormat,BufferTarget].every(Boolean))
    throw new Error('WebCodecs-библиотека несовместима.');
  const input=new Input({formats:ALL_FORMATS,source:new BlobSource(file)});
  let conversion,abortHandler;
  try{
    const videoTracks=await input.getVideoTracks();const audioTracks=await input.getAudioTracks();
    if(videoTracks.length!==1||audioTracks.length>1)throw new Error('Для тестового WebCodecs нужны одна видеодорожка и не более одной аудиодорожки.');
    const track=videoTracks[0];const width=await track.getDisplayWidth();const height=await track.getDisplayHeight();
    if(!(width>0&&height>0))throw new Error('Не удалось определить размеры WebCodecs-кадра.');
    const size=scaledSize(width,height,options.resolution||'original');
    if(size.width*size.height>16_000_000)throw new Error('Для кодирования требуется 1080p или меньше.');
    const output=new Output({format:new Mp4OutputFormat(),target:new BufferTarget()});
    const video={forceTranscode:true};
    if(size.width!==width||size.height!==height){Object.assign(video,{width:size.width,height:size.height,fit:'contain'});}
    if(mode==='compress'&&Quality)video.quality=new Quality({bitrate:Math.max(200000,Math.min(10000000,Number(options.bitrate)||650000))});
    if(mode==='convert'&&Number(options.fps)>0)video.frameRate=Number(options.fps);
    onProgress({stage:'preparing',description:'Проверка кодеков и дорожек WebCodecs…'});
    conversion=await Conversion.init({input,output,video,tracks:'all'});
    if(!conversion.isValid||conversion.discardedTracks.length||conversion.utilizedTracks.length!==videoTracks.length+audioTracks.length)
      throw new Error('WebCodecs не может сохранить все дорожки; выполняется резервный экспорт.');
    aborted(signal);
    abortHandler=()=>{void conversion.cancel().catch(()=>{});};
    signal?.addEventListener('abort',abortHandler,{once:true});
    conversion.onProgress=p=>{if(!signal?.aborted&&Number.isFinite(p))onProgress({stage:'processing',percent:Math.max(0,Math.min(99,p*100)),description:'Аппаратное кодирование WebCodecs…'});};
    await conversion.execute();aborted(signal);
    const bytes=output.target.buffer;
    if(!bytes?.byteLength)throw new Error('WebCodecs не создал выходной MP4.');
    const blob=new Blob([bytes],{type:'video/mp4'});
    // A successful encoder promise is not proof of a usable output: verify that
    // the MP4 can be read and every expected audio/video track is still present.
    const verification=new Input({formats:ALL_FORMATS,source:new BlobSource(blob)});
    try{
      const [videos,audios]=await Promise.all([verification.getVideoTracks(),verification.getAudioTracks()]);
      if(videos.length!==videoTracks.length||audios.length!==audioTracks.length)
        throw new Error('В MP4-результате отсутствует исходная аудио- или видеодорожка.');
    }finally{try{verification.dispose?.();}catch{}}
    aborted(signal);
    onProgress({stage:'complete',percent:100,description:'WebCodecs: MP4 готов.'});
    return {blob,ext:'mp4',method:'webcodecs',fast:false,info:'Экспериментальное кодирование WebCodecs; аудио и видео сохранены.'};
  }finally{
    if(abortHandler)signal?.removeEventListener('abort',abortHandler);
    // In recent Mediabunny releases Input.dispose frees backing decoders and resources.
    try{input.dispose?.();}catch{}
  }
}
export async function runFfmpeg({file,mode,options,signal,onProgress=()=>{},WorkerImpl=globalThis.Worker,loadBlob=cachedBlob}={}){
  aborted(signal);
  if(typeof WorkerImpl!=='function')throw new Error('Web Workers не поддерживаются.');
  if(file.size>MAX_FFMPEG_BYTES)throw new Error('FFmpeg/WASM: файл больше 90 МиБ; будет обычный экспорт.');
  onProgress({stage:'preparing',description:'Загрузка FFmpeg/WASM (однопоточное ядро ≈31 МБ, только при выборе)…'});
  const coreScript=await loadBlob(DEPENDENCIES.ffmpegCore,{signal});
  const coreWasm=await loadBlob(DEPENDENCIES.ffmpegWasm,{signal});
  aborted(signal);
  const scriptUrl=URL.createObjectURL(new Blob([coreScript],{type:'text/javascript'})),wasmUrl=URL.createObjectURL(coreWasm);
  let worker;
  const timeoutMs=6*60*1000;
  let timeout,abortHandler;
  try{
    worker=new WorkerImpl(new URL('./experimental-ffmpeg-worker.js',import.meta.url));
    const bytes=await file.arrayBuffer();aborted(signal);
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const done=(err,result)=>{if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener('abort',abortHandler);if(err)reject(err);else resolve(result);};
      abortHandler=()=>done(abortError());
      signal?.addEventListener('abort',abortHandler,{once:true});
      timeout=setTimeout(()=>done(new Error('FFmpeg/WASM превысил лимит ожидания 6 минут.')),timeoutMs);
      worker.onmessage=e=>{
        const msg=e.data;
        if(msg.type==='progress')onProgress({stage:'processing',description:'FFmpeg/WASM: обработка…',percent:Math.min(99,Math.max(0,Number(msg.percent)||0))});
        if(msg.type==='error')done(new Error(msg.message||'FFmpeg/WASM не выполнил операцию.'));
        if(msg.type==='done'){
          const data=msg.data;
          if(!data?.byteLength){done(new Error('FFmpeg/WASM вернул пустой результат.'));return;}
          onProgress({stage:'complete',percent:100,description:'FFmpeg/WASM: MP4 готов.'});
          done(null,{blob:new Blob([data],{type:'video/mp4'}),ext:'mp4',method:'ffmpeg-wasm',fast:false,info:'Экспериментальный однопоточный FFmpeg/WASM.'});
        }
      };
      worker.onerror=e=>done(new Error(e.message||'Ошибка рабочего потока FFmpeg/WASM.'));
      worker.postMessage({type:'run',coreScriptUrl:scriptUrl,wasmUrl,bytes,mode,resolution:options.resolution||'original',bitrate:Number(options.bitrate)||650000,name:file.name},[bytes]);
      if(signal?.aborted)abortHandler();
    });
  }finally{clearTimeout(timeout);worker?.terminate();URL.revokeObjectURL(scriptUrl);URL.revokeObjectURL(wasmUrl);}
}
export async function tryExperimental({files,mode,options={},onProgress=()=>{},signal}={}){
  const eligibility=experimentalEligibility({files,mode,options});
  if(!eligibility.eligible){
    if(options.engine&&options.engine!=='classic')onProgress({stage:'preparing',description:eligibility.reason+' — используем резервный движок.'});
    return null;
  }
  try{
    const task={file:files[0],mode,options,signal,onProgress};
    return eligibility.engine==='webcodecs'?await runWebCodecs(task):await runFfmpeg(task);
  }catch(e){
    if(e?.name==='AbortError'||signal?.aborted)throw e;
    console.warn('Экспериментальный движок недоступен; используем проверенный экспорт:',e);
    onProgress({stage:'preparing',description:`${eligibility.engine==='ffmpeg'?'FFmpeg/WASM':'WebCodecs'} недоступен: ${e.message||e}. Используем резервный экспорт.`});
    return null;
  }
}
