/** Optional client-side engines. The ordinary Lokit pipeline never loads these. */
export const ENGINE_OPTIONS = ['classic','webcodecs','ffmpeg'];
export const EXPERIMENTAL_MODES = new Set(['convert','compress']);
import {DEPENDENCIES, fetchCodecBlob} from './codec-assets.js';
export {DEPENDENCIES};
const MAX_FFMPEG_BYTES=90*1024*1024;
const abortError=()=>new DOMException('Операция отменена','AbortError');
export function experimentalEligibility({files,mode,options={}}={}){
  const engine=options.engine||'classic';
  if(engine==='classic')return {eligible:false,reason:'Обычный способ экспорта'};
  if(!ENGINE_OPTIONS.includes(engine))return {eligible:false,reason:'Неизвестный способ экспорта'};
  if(!EXPERIMENTAL_MODES.has(mode)||!files?.length||files.length!==1)return {eligible:false,reason:'Этот инструмент нельзя использовать с выбранным способом экспорта'};
  if(!files[0]?.size)return {eligible:false,reason:'Выбранный файл пуст'};
  if(engine==='webcodecs'&&(typeof VideoEncoder==='undefined'||typeof VideoDecoder==='undefined'))
    return {eligible:false,reason:'Ваш браузер не поддерживает WebCodecs'};
  if(engine==='ffmpeg'&&files[0].size>MAX_FFMPEG_BYTES)
    return {eligible:false,reason:'FFmpeg/WASM принимает файлы до 90 МиБ, чтобы не перегружать память'};
  return {eligible:true,engine};
}
function aborted(signal){if(signal?.aborted)throw abortError();}
// Load only same-origin media runtimes and store them for optional offline reuse.
const cachedBlob = fetchCodecBlob;
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
    const video={forceTranscode:true};
    if(size.width!==width||size.height!==height){Object.assign(video,{width:size.width,height:size.height,fit:'contain'});}
    if(mode==='compress'&&Quality)video.quality=new Quality({bitrate:Math.max(200000,Math.min(10000000,Number(options.bitrate)||650000))});
    if(mode==='convert'&&Number(options.fps)>0)video.frameRate=Number(options.fps);
    onProgress({stage:'preparing',description:'Проверяем дорожки и поддержку кодеков…'});
    conversion=await Conversion.init({input,output,video,tracks:'all'});
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
    return {blob,ext:'mp4',method:'webcodecs',fast:false,info:'Видео и звук сохранены с помощью экспериментального WebCodecs.'};
  }finally{
    if(abortHandler)signal?.removeEventListener('abort',abortHandler);
    // In recent Mediabunny releases Input.dispose frees backing decoders and resources.
    try{input.dispose?.();}catch{}
  }
}
export async function runFfmpeg({file,mode,options,signal,onProgress=()=>{},WorkerImpl=globalThis.Worker,loadBlob=cachedBlob}={}){
  aborted(signal);
  if(typeof WorkerImpl!=='function')throw new Error('Этот браузер не поддерживает фоновые вычисления Web Workers.');
  if(file.size>MAX_FFMPEG_BYTES)throw new Error('Файл слишком большой для FFmpeg/WASM (более 90 МиБ). Используем обычный экспорт.');
  onProgress({stage:'preparing',description:'Загружаем FFmpeg/WASM (около 31 МБ при первом запуске)…'});
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
      timeout=setTimeout(()=>done(new Error('FFmpeg/WASM не завершил работу за 6 минут.')),timeoutMs);
      worker.onmessage=e=>{
        const msg=e.data;
        if(msg.type==='progress')onProgress({stage:'processing',description:'Обрабатываем видео через FFmpeg/WASM…',percent:Math.min(99,Math.max(0,Number(msg.percent)||0))});
        if(msg.type==='error')done(new Error(msg.message||'FFmpeg/WASM не смог обработать файл.'));
        if(msg.type==='done'){
          const data=msg.data;
          if(!data?.byteLength){done(new Error('FFmpeg/WASM не создал файл.'));return;}
          onProgress({stage:'complete',percent:100,description:'MP4 готов (FFmpeg/WASM).'});
          done(null,{blob:new Blob([data],{type:'video/mp4'}),ext:'mp4',method:'ffmpeg-wasm',fast:false,info:'Видео обработано в экспериментальном режиме FFmpeg/WASM.'});
        }
      };
      worker.onerror=e=>done(new Error(e.message||'Не удалось запустить обработку через FFmpeg/WASM.'));
      worker.postMessage({type:'run',coreScriptUrl:scriptUrl,wasmUrl,bytes,mode,resolution:options.resolution||'original',bitrate:Number(options.bitrate)||650000,name:file.name},[bytes]);
      if(signal?.aborted)abortHandler();
    });
  }finally{clearTimeout(timeout);worker?.terminate();URL.revokeObjectURL(scriptUrl);URL.revokeObjectURL(wasmUrl);}
}
export async function tryExperimental({files,mode,options={},onProgress=()=>{},signal}={}){
  const eligibility=experimentalEligibility({files,mode,options});
  if(!eligibility.eligible){
    if(options.engine&&options.engine!=='classic')onProgress({stage:'preparing',description:eligibility.reason+' — пробуем обычный экспорт.'});
    return null;
  }
  try{
    const task={file:files[0],mode,options,signal,onProgress};
    return eligibility.engine==='webcodecs'?await runWebCodecs(task):await runFfmpeg(task);
  }catch(e){
    if(e?.name==='AbortError'||signal?.aborted)throw e;
    console.warn('Экспериментальный режим недоступен; переключаемся на обычный экспорт:',e);
    onProgress({stage:'preparing',description:`${eligibility.engine==='ffmpeg'?'FFmpeg/WASM':'WebCodecs'} недоступен: ${e.message||e}. Пробуем обычный экспорт.`});
    return null;
  }
}
