/** Optional client-side engines. The ordinary Lokit pipeline never loads these. */
export const ENGINE_OPTIONS = ['auto','classic','webcodecs','ffmpeg'];
export const EXPERIMENTAL_MODES = new Set(['convert','compress']);
const FFMPEG_MODES = new Set(['convert','compress','trim','mute','speed','loop',
  'crop','flip-h','flip-v','rotate-90','rotate-180','rotate-270','filter','blur',
  'volume','extract-audio','frame','merge','split','watermark','vr']);
// The codec libraries are vendored into the site, not fetched from a CDN.
import {DEPENDENCIES, fetchCodecBlob, CODEC_CACHE} from './codec-assets.js';
export {DEPENDENCIES};
const CACHE=CODEC_CACHE;
const MAX_FFMPEG_BYTES=90*1024*1024;
const abortError=()=>new DOMException('Операция отменена','AbortError');
export function experimentalEligibility({files,mode,options={}}={}){
  const engine=options.engine||'auto';
  if(engine==='classic')return {eligible:false,reason:'Обычный способ экспорта'};
  if(!ENGINE_OPTIONS.includes(engine))return {eligible:false,reason:'Неизвестный способ экспорта'};
  const expected=engine==='ffmpeg'&&['merge','split'].includes(mode)?2:1;
  if(!files?.length||files.length!==expected||!(engine==='ffmpeg'?FFMPEG_MODES:EXPERIMENTAL_MODES).has(mode))return {eligible:false,reason:'Инструмент не поддерживается экспериментальным движком'};
  if(files.some(item=>!item?.size))return {eligible:false,reason:'Один из исходных файлов пуст'};
  if((engine==='auto'||engine==='webcodecs')&&(typeof VideoEncoder==='undefined'||typeof VideoDecoder==='undefined'))
    return {eligible:false,reason:'Ваш браузер не поддерживает WebCodecs'};
  if(engine==='ffmpeg'&&files.reduce((total,f)=>total+f.size,0)>MAX_FFMPEG_BYTES)
    return {eligible:false,reason:'FFmpeg/WASM принимает файлы до 90 МиБ, чтобы не перегружать память'};
  return {eligible:true,engine:engine==='auto'?'webcodecs':engine,automatic:engine==='auto'};
}
function aborted(signal){if(signal?.aborted)throw abortError();}
// Only approved same-origin assets may be loaded; the dedicated loader
// handles Cache Storage, offline availability, errors and abort.
const cachedBlob=fetchCodecBlob;
let mediabunnyPromise;
async function loadMediabunny({signal,onProgress=()=>{}}={}){
  if(globalThis.Mediabunny)return globalThis.Mediabunny;
  if(typeof document==='undefined')throw new Error('WebCodecs можно использовать только в поддерживаемом браузере.');
  mediabunnyPromise ||= (async()=>{
    onProgress({stage:'preparing',description:'Подготавливаем локальный компонент WebCodecs…'});
    const downloaded=await cachedBlob(DEPENDENCIES.mediabunny,{signal});
    const url=URL.createObjectURL(new Blob([downloaded],{type:'text/javascript'}));
    try{
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=url;script.async=true;
        const clean=()=>{script.remove();signal?.removeEventListener('abort',onAbort);};
        const onAbort=()=>{clean();reject(abortError());};
        script.onload=()=>{clean();resolve();};script.onerror=()=>{clean();reject(new Error('Не удалось запустить компонент WebCodecs.'));};
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted){onAbort();return;}
        document.head.append(script);
      });
      if(!globalThis.Mediabunny)throw new Error('Не удалось инициализировать компонент WebCodecs.');
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
    throw new Error('Этот браузер несовместим с выбранным компонентом WebCodecs.');
  const input=new Input({formats:ALL_FORMATS,source:new BlobSource(file)});
  let conversion,abortHandler;
  try{
    const videoTracks=await input.getVideoTracks();const audioTracks=await input.getAudioTracks();
    if(videoTracks.length!==1||audioTracks.length>1)throw new Error('Для WebCodecs нужен файл с одной видеодорожкой и не более чем одной звуковой.');
    const track=videoTracks[0];const width=await track.getDisplayWidth();const height=await track.getDisplayHeight();
    if(!(width>0&&height>0))throw new Error('Не удалось определить разрешение видео для WebCodecs.');
    const size=scaledSize(width,height,options.resolution||'original');
    if(size.width*size.height>16_000_000)throw new Error('Для этого режима выберите разрешение не выше 1080p.');
    const output=new Output({format:new Mp4OutputFormat(),target:new BufferTarget()});
    // Mediabunny can transmux H.264/AAC or AV1/VP9 streams directly from
    // MOV/MKV/WebM into MP4 when the container accepts them. Never force
    // transcoding for a plain conversion. Compression, resizing and FPS
    // overrides will still encode the video as required.
    // MP4 can *contain* HEVC/VP9/AV1 but many external players cannot decode
    // those streams. Request the portable AVC/AAC pair; Mediabunny can still
    // copy existing AVC/AAC packets without touching their bitstreams.
    const video={codec:'avc',hardwareAcceleration:'prefer-hardware'};
    if(mode==='compress')video.forceTranscode=true;
    if(size.width!==width||size.height!==height){Object.assign(video,{width:size.width,height:size.height,fit:'contain'});}
    if(mode==='compress'&&Quality)video.quality=new Quality({bitrate:Math.max(200000,Math.min(10000000,Number(options.bitrate)||650000))});
    if(mode==='convert'&&Number(options.fps)>0)video.frameRate=Number(options.fps);
    onProgress({stage:'preparing',description:'Проверяем дорожки и поддержку кодеков…'});
    conversion=await Conversion.init({input,output,video,audio:{codec:'aac'},tracks:'all'});
    if(!conversion.isValid||conversion.discardedTracks.length||conversion.utilizedTracks.length!==videoTracks.length+audioTracks.length)
      throw new Error('WebCodecs не может сохранить все дорожки. Переключаемся на обычный экспорт.');
    aborted(signal);
    abortHandler=()=>{void conversion.cancel().catch(()=>{});};
    signal?.addEventListener('abort',abortHandler,{once:true});
    conversion.onProgress=p=>{if(!signal?.aborted&&Number.isFinite(p))onProgress({stage:'processing',percent:Math.max(0,Math.min(99,p*100)),description:'Обрабатываем видео с помощью WebCodecs…'});};
    await conversion.execute();aborted(signal);
    const bytes=output.target.buffer;
    if(!bytes?.byteLength)throw new Error('WebCodecs не смог создать MP4.');
    const blob=new Blob([bytes],{type:'video/mp4'});
    // A successful encoder promise is not proof of a usable output: verify that
    // the MP4 can be read and every expected audio/video track is still present.
    const verification=new Input({formats:ALL_FORMATS,source:new BlobSource(blob)});
    try{
      const [videos,audios]=await Promise.all([verification.getVideoTracks(),verification.getAudioTracks()]);
      if(videos.length!==videoTracks.length||audios.length!==audioTracks.length)
        throw new Error('В созданном MP4 не хватает звуковой или видеодорожки.');
    }finally{try{verification.dispose?.();}catch{}}
    aborted(signal);
    onProgress({stage:'complete',percent:100,description:'MP4 готов (WebCodecs).'});
    return {blob,ext:'mp4',method:'webcodecs',fast:false,info:mode==='convert'?'Mediabunny: H.264/AAC копируются, когда возможно; прочие кодеки преобразуются в H.264/AAC. Дорожки проверены.':'WebCodecs: видео сжато, исходная аудиодорожка сохранена, когда это возможно.'};
  }finally{
    if(abortHandler)signal?.removeEventListener('abort',abortHandler);
    // In recent Mediabunny releases Input.dispose frees backing decoders and resources.
    try{input.dispose?.();}catch{}
  }
}
export async function runFfmpeg({file,files,mode,options={},signal,onProgress=()=>{},WorkerImpl=globalThis.Worker,loadBlob=cachedBlob}={}){
  files ||= file?[file]:[];
  aborted(signal);
  if(typeof WorkerImpl!=='function')throw new Error('Этот браузер не поддерживает фоновые вычисления Web Workers.');
  if(!files.length||files.some(item=>!item?.size)||files.reduce((sum,item)=>sum+item.size,0)>MAX_FFMPEG_BYTES)
    throw new Error('FFmpeg/WASM: суммарный размер исходников больше 90 МиБ или отсутствует видео.');
  onProgress({stage:'preparing',description:'Подготавливаем FFmpeg/WASM из файлов сайта (≈31 МБ)…'});
  const coreScript=await loadBlob(DEPENDENCIES.ffmpegCore,{signal});
  const coreWasm=await loadBlob(DEPENDENCIES.ffmpegWasm,{signal});
  aborted(signal);
  const scriptUrl=URL.createObjectURL(new Blob([coreScript],{type:'text/javascript'})),wasmUrl=URL.createObjectURL(coreWasm);
  let worker;
  const timeoutMs=6*60*1000;
  let timeout,abortHandler;
  try{
    worker=new WorkerImpl(new URL('./experimental-ffmpeg-worker.js',import.meta.url));
    const inputs=await Promise.all(files.map(async file=>({name:file.name,bytes:await file.arrayBuffer()})));aborted(signal);
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const done=(err,result)=>{if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener('abort',abortHandler);if(err)reject(err);else resolve(result);};
      abortHandler=()=>done(abortError());
      signal?.addEventListener('abort',abortHandler,{once:true});
      timeout=setTimeout(()=>done(new Error('FFmpeg/WASM не завершил работу за 6 минут.')),timeoutMs);
      worker.onmessage=e=>{
        const msg=e.data;
        if(msg.type==='progress')onProgress({stage:'processing',description:'Обрабатываем видео через FFmpeg/WASM…',percent:Math.min(99,Math.max(0,Number(msg.percent)||0))});
        if(msg.type==='error')done(new Error(msg.message||'FFmpeg/WASM не смог обработать файл.'));
        if(msg.type==='done'){
          const data=msg.data;
          if(!data?.byteLength){done(new Error('FFmpeg/WASM не создал файл.'));return;}
          const ext=msg.ext||'mp4';
          const header=new Uint8Array(data,0,Math.min(12,data.byteLength));
          const valid=ext==='png'
            ?header.length>=8&&[137,80,78,71,13,10,26,10].every((byte,i)=>header[i]===byte)
            :header.length>=12&&String.fromCharCode(...header.subarray(4,8))==='ftyp';
          if(!valid){done(new Error('FFmpeg/WASM вернул файл с повреждённым заголовком.'));return;}
          const mime=ext==='m4a'?'audio/mp4':ext==='png'?'image/png':'video/mp4';
          onProgress({stage:'complete',percent:100,description:'FFmpeg/WASM: '+ext.toUpperCase()+' готов.'});
          done(null,{blob:new Blob([data],{type:mime}),ext,method:'ffmpeg-wasm',fast:false,info:'Совместимый '+ext.toUpperCase()+' через FFmpeg/WASM, кодирование выполняется локально.'});
        }
      };
      worker.onerror=e=>done(new Error(e.message||'Не удалось запустить обработку через FFmpeg/WASM.'));
      // Transfer, don't clone, the two video buffers into the worker.
      const buffers=inputs.map(item=>item.bytes);
      worker.postMessage({type:'run',coreScriptUrl:scriptUrl,wasmUrl,inputs,mode,options:{...options}},buffers);
      if(signal?.aborted)abortHandler();
    });
  }finally{clearTimeout(timeout);worker?.terminate();URL.revokeObjectURL(scriptUrl);URL.revokeObjectURL(wasmUrl);}
}
export async function tryExperimental({files,mode,options={},onProgress=()=>{},signal,strict=false}={}){
  const eligibility=experimentalEligibility({files,mode,options});
  if(!eligibility.eligible){
    if(strict)throw new Error(eligibility.reason);
    if(options.engine&&options.engine!=='classic')onProgress({stage:'preparing',description:eligibility.reason+' — пробуем обычный экспорт.'});
    return null;
  }
  try{
    // Auto selection never downloads optional code. WebCodecs starts
    // automatically only after the bundled muxer has been cached.
    if(eligibility.automatic&&!globalThis.Mediabunny){
      if(typeof caches==='undefined')return null;
      const cached=await (await caches.open(CACHE)).match(DEPENDENCIES.mediabunny);
      if(!cached)return null;
    }
    aborted(signal);
    const task={file:files[0],files,mode,options,signal,onProgress};
    return eligibility.engine==='webcodecs'?await runWebCodecs(task):await runFfmpeg(task);
  }catch(e){
    if(e?.name==='AbortError'||signal?.aborted||strict)throw e;
    console.warn('Экспериментальный режим недоступен; переключаемся на обычный экспорт:',e);
    onProgress({stage:'preparing',description:`${eligibility.engine==='ffmpeg'?'FFmpeg/WASM':'WebCodecs'} недоступен: ${e.message||e}. Пробуем обычный экспорт.`});
    return null;
  }
}
