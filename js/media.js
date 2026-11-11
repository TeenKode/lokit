// Браузерный движок обработки пользовательских файлов. Не использует серверные API.
import {renderVideoFrame,canvasSize} from './render.js';
import {tryFastMp4,tryFastExtractAudio,inspectContainer} from './mp4-fast.js';
import {tryExperimental} from './experimental-engines.js';
const VIDEO_TYPES = [
  // Native H.264 may use hardware acceleration. MediaRecorder still decides
  // whether the encoder is actually available; WebM VP8 is the safe fallback.
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8', 'video/webm', 'video/mp4'
];
const VIDEO_SILENT_TYPES=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function ensure(value, message) { if (!value) throw new Error(message); }
function onAbort(signal) { if (signal?.aborted) throw new DOMException('Отменено', 'AbortError'); }
function filename(file) { return file?.name || 'видео'; }
function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
export function outputName(file, suffix, ext) {
  return `${filename(file).replace(/\.[^.]+$/, '')}-${suffix}.${ext}`;
}

function releaseVideo(video,url){
  // Removing an element alone does not necessarily release the decoder.
  try{video.pause();}catch{}
  try{video.removeAttribute('src');video.load();}catch{}
  try{video.remove();}catch{}
  URL.revokeObjectURL(url);
}
export function awaitMedia(promise,{signal,timeoutMs=18000,message='Браузер слишком долго обрабатывает файл. Попробуйте ещё раз или выберите другой формат.'}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>finish(new DOMException('Отменено','AbortError'));
    const timer=setTimeout(()=>finish(new Error(message)),timeoutMs);
    function finish(error,value){
      if(settled)return;
      settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(value);
    }
    // Always handle the source promise, including late errors after cancellation.
    Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
}
function abortableDelay(milliseconds,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new DOMException('Отменено','AbortError'));return;}
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Отменено','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},milliseconds);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

export async function openVideo(file,signal) {
  onAbort(signal);
  ensure(file instanceof File, 'Сначала выберите видео.');
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.src = url;
  video.preload = 'auto'; video.playsInline = true;
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  let released=false;
  const close=()=>{if(released)return;released=true;releaseVideo(video,url);};
  try {
    document.body.append(video);
    await new Promise((resolve,reject)=>{
      let finished=false;
      const timeout=setTimeout(()=>finish(new Error('Не удалось открыть видео. Проверьте формат и целостность файла.')),18000);
      const loaded=()=>finish();
      const failure=()=>finish(new Error('Браузер не поддерживает этот видеофайл или файл повреждён.'));
      const aborted=()=>finish(new DOMException('Отменено','AbortError'));
      function finish(error){
        if(finished)return;finished=true;clearTimeout(timeout);
        video.removeEventListener('loadedmetadata',loaded);
        video.removeEventListener('error',failure);
        signal?.removeEventListener('abort',aborted);
        if(error)reject(error);else resolve();
      }
      video.addEventListener('loadedmetadata',loaded);
      video.addEventListener('error',failure);
      signal?.addEventListener('abort',aborted,{once:true});
      if(signal?.aborted){aborted();return;}
      video.load();
    });
    ensure(video.videoWidth && video.videoHeight, 'Не удалось определить разрешение видео.');
    ensure(Number.isFinite(video.duration) && video.duration > 0, 'Не удалось узнать длительность видео.');
    return { video, url, duration:video.duration, width:video.videoWidth, height:video.videoHeight,
      close };
  } catch (error) { close(); throw error; }
}

export function supportedMediaFeatures(){
  return {
    mediaRecorder:typeof MediaRecorder!=='undefined',
    canvasCapture:typeof HTMLCanvasElement!=='undefined'&&typeof HTMLCanvasElement.prototype.captureStream==='function',
    webCodecs:typeof VideoEncoder!=='undefined'&&typeof VideoDecoder!=='undefined',
    frameCallback:typeof HTMLVideoElement!=='undefined'&&'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    offscreenCanvas:typeof OffscreenCanvas!=='undefined'
  };
}
// Синхронизация с декодированными кадрами вместо бесконечного setInterval.
// Таймаут оставлен на случай неподвижного кадра или проблемного контейнера.
function nextVideoFrame(video,fps,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new DOMException('Отменено','AbortError'));return;}
    let settled=false,handle=null,timer;
    const callbackSupported=typeof video?.requestVideoFrameCallback==='function';
    const done=(error)=>{
      if(settled)return;settled=true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',aborted);
      if(handle!==null&&callbackSupported&&typeof video.cancelVideoFrameCallback==='function')video.cancelVideoFrameCallback(handle);
      if(error)reject(error);else resolve();
    };
    const aborted=()=>done(new DOMException('Отменено','AbortError'));
    signal?.addEventListener('abort',aborted,{once:true});
    // Проверка состояния каждые ~два кадра, без зависания при завершении воспроизведения.
    timer=setTimeout(()=>done(),callbackSupported?Math.max(90,Math.ceil(2500/fps)):Math.max(25,Math.ceil(1000/fps)));
    if(callbackSupported)handle=video.requestVideoFrameCallback(()=>done());
  });
}

async function seek(video, at, signal) {
  onAbort(signal);
  const same = Math.abs(video.currentTime-at)<.015;
  if (same && video.readyState>=2) return;
  await new Promise((resolve,reject)=>{
    const eventName=same?'loadeddata':'seeked';
    const timeout = setTimeout(()=>{done();reject(new Error('Не удалось показать выбранный кадр.'));},12000);
    const aborted = () => {done();reject(new DOMException('Отменено','AbortError'));};
    const ok = () => {done();resolve();};
    const done = () => {clearTimeout(timeout);video.removeEventListener(eventName,ok);signal?.removeEventListener('abort',aborted);};
    video.addEventListener(eventName,ok,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    try {
      if(!same)video.currentTime=at;
      else if(video.readyState>=2)ok();
    }catch(error){done();reject(error);}
  });
}

/** Detect damaged/stalled decoders without forcing the user to wait forever.
 * Resets after seeking backwards or switching clips; does not mistake a slow
 * encoder for a stalled decoder (it watches media time, not wall-clock FPS).
 */
export function playbackWatchdog({maxIdleMs=15000,now=()=>performance.now()}={}){
  let lastTime=null,lastAdvance=now();
  return position=>{
    const current=Number(position);
    if(!Number.isFinite(current))throw new Error('Не удалось определить положение воспроизведения. Попробуйте другой браузер.');
    const tick=now();
    if(lastTime===null||current>lastTime+.004||current<lastTime-.05){
      lastTime=current;lastAdvance=tick;return;
    }
    if(tick-lastAdvance>maxIdleMs)throw new Error('Браузер перестал воспроизводить файл. Попробуйте другой формат видео или другой браузер.');
  };
}

export function splitPlaybackWatchdog({maxIdleMs=15000,now=()=>performance.now()}={}){
  const first=playbackWatchdog({maxIdleMs,now});
  const second=playbackWatchdog({maxIdleMs,now});
  return ({primary,secondary,secondStarted})=>{
    if(!primary.ended)first(primary.currentTime);
    if(secondStarted&&!secondary.ended)second(secondary.currentTime);
  };
}

function recorderFor(stream, {videoBitsPerSecond=2500000,audioOnly=false}={}) {
  ensure(typeof MediaRecorder!=='undefined', 'В этом браузере недоступна запись видео.');
  const types=audioOnly?AUDIO_TYPES:stream.getAudioTracks().length?VIDEO_TYPES:VIDEO_SILENT_TYPES;
  let recorder=null,mime='';
  for(const candidate of types){
    if(!MediaRecorder.isTypeSupported(candidate))continue;
    try{
      recorder=new MediaRecorder(stream,audioOnly?{mimeType:candidate}:{mimeType:candidate,videoBitsPerSecond});
      mime=candidate;break;
    }catch{/* Try the next native encoder if a MIME is advertised but unusable. */}
  }
  ensure(recorder, 'Браузер не поддерживает экспорт аудио/видео в доступный формат.');
  const chunks=[];
  recorder.addEventListener('dataavailable',e=>{if(e.data?.size)chunks.push(e.data);});
  const done=new Promise((resolve,reject)=>{
    recorder.addEventListener('stop',()=>resolve(new Blob(chunks,{type:recorder.mimeType||mime})),{once:true});
    recorder.addEventListener('error',e=>reject(e.error||new Error('Не удалось закодировать видео.')),{once:true});
  });
  return {recorder,done,mime};
}
function extension(mime, audio=false){return mime.includes('mp4')?(audio?'m4a':'mp4'):(audio?'webm':'webm');}
function connectAudio(ctx, videos, stream, gainValue=1) {
  const destination=ctx.createMediaStreamDestination();
  for (const video of videos) {
    const source=ctx.createMediaElementSource(video);
    const gain=ctx.createGain();gain.gain.value=gainValue;
    source.connect(gain);gain.connect(destination);
  }
  for(const track of destination.stream.getAudioTracks())stream.addTrack(track);
}
async function tryOriginalVideoCopy(file,options,signal){
  // "Convert" with unchanged resolution and frame rate is already complete
  // when the original format can be opened by this browser. A requested FPS
  // or resolution change must never silently return the unmodified source.
  if(!file?.size || String(options.resolution||'original')!=='original'
    ||(options.fps&&options.fps!=='original')
    ||(options.engine&&!['auto','classic'].includes(options.engine))
    ||!/\.(mp4|m4v|webm)$/i.test(file.name||''))return null;
  let item;
  try{
    item=await openVideo(file,signal);
    const ext=/\.webm$/i.test(file.name)?'webm':'mp4';
    const mime=file.type||('video/'+ext);
    if(typeof item.video.canPlayType!=='function'||!item.video.canPlayType(mime))return null;
    onAbort(signal);
    return {blob:file,ext,type:mime,fast:true,method:'copy',info:'Формат уже поддерживается браузером. Исходные видео и звук сохранены без изменений.'};
  }catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw error;
    return null;
  }finally{item?.close();}
}
async function watermarkBitmap(text,signal){
  onAbort(signal);
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=160;
  const ctx=canvas.getContext('2d');
  ensure(ctx,'Этот браузер не умеет создавать PNG с текстом.');
  const label=String(text||'Моё видео').slice(0,80);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.font='700 64px system-ui,sans-serif';
  ctx.textAlign='right';ctx.textBaseline='bottom';
  ctx.shadowColor='#000';ctx.shadowBlur=10;
  ctx.fillStyle='#fff';ctx.fillText(label,980,135,960);
  const png=await awaitMedia(new Promise((resolve,reject)=>
    canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось подготовить текстовую подпись.')),'image/png')),
    {signal,timeoutMs:20000,message:'Не удалось создать текстовую подпись.'});
  onAbort(signal);
  ensure(png.size>0&&png.size<2*1024*1024,'Неверный размер подписи PNG.');
  return png.arrayBuffer();
}
async function compatibilityFallback(filesOrFile,mode,options,onProgress,signal,error){
  if(error?.name==='AbortError'||signal?.aborted)throw error;
  // A format unsupported by HTMLVideoElement is not necessarily unsupported
  // by FFmpeg/WASM. Always pass *all* source clips to preserve both timelines.
  const files=Array.isArray(filesOrFile)?filesOrFile:[filesOrFile];
  const parameters={...options,engine:'ffmpeg'};
  if(['merge','split'].includes(mode)){
    const source=await inspectContainer(files[0],signal);
    if(source?.width>0&&source?.height>0){
      parameters.targetWidth=source.width;parameters.targetHeight=source.height;
    }
  }
  if(mode==='watermark')parameters.watermarkPng=await watermarkBitmap(options.text,signal);
  onProgress({stage:'preparing',description:'Браузер не открыл исходник. Используем совместимый FFmpeg/WASM…'});
  let converted;
  try{
    converted=await tryExperimental({files,mode,options:parameters,onProgress,signal,strict:true});
  }catch(failure){
    if(failure?.name==='AbortError'||signal?.aborted)throw failure;
    throw new Error('FFmpeg/WASM не смог обработать файл: '+String(failure?.message||failure)+
      '. Исходный браузерный декодер также отказал: '+String(error?.message||error));
  }
  if(converted){
    if(['merge','split'].includes(mode))
      converted.info+=' Несовместимые источники нормализованы до H.264/AAC; звук и порядок дорожек сохранены.';
    if(mode==='watermark')converted.info+=' Текст отрисован браузером в PNG, включая кириллицу.';
    return converted;
  }
  const totalSize=files.reduce((total,file)=>total+(file?.size||0),0);
  const limit=totalSize>90*1024*1024
    ?' Суммарный размер файлов превышает лимит FFmpeg/WASM 90 МиБ.'
    :' Для первого использования FFmpeg/WASM может потребоваться интернет.';
  throw new Error('Браузер не смог декодировать исходный формат или кодек. '+
    String(error?.message||'')+limit);
}
export async function transformVideo({files, mode='convert', options={}, onProgress=()=>{}, signal}){
  // Use the selected clip order in both fast MP4 and ordinary export.
  if(mode==='merge'&&options.clipOrder==='reverse'&&files?.length===2)files=[files[1],files[0]];
  if(mode==='convert'){
    const unchanged=await tryOriginalVideoCopy(files?.[0],options,signal);
    if(unchanged){
      onProgress({stage:'complete',percent:100,description:'Файл сохранён без перекодирования.'});
      return unchanged;
    }
  }
  // Try container surgery first: a compatible MP4 can be edited without decoding.
  const fast=await tryFastMp4({files,mode,options,onProgress,signal});
  if(fast)return fast;
  // Opt-in accelerated alternatives; errors return null and use the proven path.
  const alternative=await tryExperimental({files,mode,options,onProgress,signal});
  if(alternative)return alternative;
  onProgress({stage:'preparing',description:'Читаем данные видео…'});
  let primary;
  try{primary=await openVideo(files[0],signal);}
  catch(error){return compatibilityFallback(files,mode,options,onProgress,signal,error);}
  let secondary=null, audioCtx=null, stream=null, recorderPack=null;
  try {
    onAbort(signal);
    if(['merge','split'].includes(mode)) {
      onProgress({stage:'preparing',description:'Загружаем второе видео…'});
      ensure(files[1], 'Этот инструмент требует два видеофайла.');
      try{secondary=await openVideo(files[1],signal);}
      catch(error){
        const dimensions={targetWidth:primary.width,targetHeight:primary.height};
        primary.close(); // release decoder and media bytes before loading WASM
        return await compatibilityFallback(files,mode,{...options,...dimensions},onProgress,signal,error);
      }
    }
    const {width,height}=canvasSize(primary,mode,options);
    ensure(width*height<=16_000_000,'Разрешение слишком высокое для обработки в браузере. Попробуйте 1080p или 720p.');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{alpha:false});
    ensure(ctx && typeof canvas.captureStream==='function','Этот браузер не поддерживает выбранный способ обработки видео.');
    const fps=clamp(Number(options.fps)||30,5,60);
    stream=canvas.captureStream(fps);
    const videos=secondary&&mode==='merge'?[primary.video,secondary.video]:[primary.video];
    const includeAudio=mode!=='mute' && options.audio!=='off';
    if(includeAudio){
      ensure(typeof AudioContext!=='undefined','Браузер не может сохранить звук этим способом. Попробуйте другой браузер.');
      try {
        audioCtx=new AudioContext();
        connectAudio(audioCtx,videos,stream,mode==='volume'?clamp(Number(options.gain)||1,0,3):1);
        await awaitMedia(audioCtx.resume(),{signal,message:'Не удалось подготовить звуковую дорожку. Попробуйте снова.'});
        ensure(audioCtx.state==='running','Браузер не разрешил использовать звук при обработке.');
        ensure(stream.getAudioTracks().length>0,'Не удалось сохранить звуковую дорожку в результате.');
      } catch(e){
        await audioCtx?.close().catch(()=>{});
        audioCtx=null;
        throw new Error(`Не удалось подготовить обработку со звуком: ${e.message||e}`);
      }
    }
    // Для split второй ролик НЕ подключён к AudioContext: глушим его
    // напрямую, иначе его звук может играть через динамики устройства.
    primary.video.muted=!audioCtx;
    if(secondary)secondary.video.muted=!audioCtx || mode==='split';
    const rate=mode==='speed'?clamp(Number(options.speed)||1,0.25,4):1;
    primary.video.playbackRate=rate;
    const start=mode==='trim'?clamp(Number(options.start)||0,0,primary.duration):0;
    const end=mode==='trim'?clamp(Number(options.end)||primary.duration,0,primary.duration):primary.duration;
    ensure(end>start,'Конец фрагмента должен быть позже начала.');
    const loopCount=mode==='loop'?clamp(Math.floor(Number(options.loops)||2),1,10):1;
    const splitOffset=mode==='split'?clamp(Number(options.offsetSeconds)||0,0,3600):0;
    const total=mode==='merge'?primary.duration+secondary.duration:mode==='split'?Math.max(primary.duration,splitOffset+secondary.duration):(end-start)*loopCount/rate;
    const bitrate=mode==='compress'?clamp(Number(options.bitrate)||650000,150000,5000000):clamp(Number(options.bitrate)||2500000,200000,15000000);
    recorderPack=recorderFor(stream,{videoBitsPerSecond:bitrate});
    const {recorder,done,mime}=recorderPack;
    onProgress({stage:'preparing',description:'Подготавливаем обработку видео…'});
    const draw=(first,second)=>renderVideoFrame(ctx,first.video,second?.video,mode,options,width,height);
    await seek(primary.video,start,signal);
    draw(primary,secondary);
    recorder.start(200);
    let runs=0,current=primary,next=secondary;
    let checkPlayback=playbackWatchdog();
    const checkSplitPlayback=mode==='split'?splitPlaybackWatchdog():null;
    const play=async item=>{
      onAbort(signal);
      try{await awaitMedia(item.video.play(),{signal,message:'Видео не начало воспроизводиться. Проверьте формат файла.'});}
      catch(e){if(e?.name==='AbortError')throw e;throw new Error(`Не удалось воспроизвести видео: ${e.message||e}`);}
    };
    await play(primary);
    const splitStartedAt=performance.now();
    let secondStarted=false;
    if(mode==='split'&&splitOffset===0){await play(secondary);secondStarted=true;}
    while(true){
      onAbort(signal);
      const elapsed=(performance.now()-splitStartedAt)/1000;
      if(mode==='split'&&!secondStarted&&elapsed>=splitOffset){await play(secondary);secondStarted=true;}
      draw(current,mode==='split'&&secondStarted?secondary:null);
      // Split-screen finishes after both videos; the longest running clock
      // should advance even when one of the streams ends before the other.
      if(mode==='split')checkSplitPlayback({primary:primary.video,secondary:secondary.video,secondStarted});
      else checkPlayback(current.video.currentTime);
      let fraction;
      if(mode==='merge')fraction=(current===primary?primary.video.currentTime:primary.duration+secondary.video.currentTime)/total;
      else if(mode==='split')fraction=Math.max(elapsed,primary.video.currentTime,secondStarted?splitOffset+secondary.video.currentTime:0)/total;
      else fraction=(runs*(end-start)+Math.min(end-start,Math.max(0,current.video.currentTime-start)))/((end-start)*loopCount);
      onProgress({stage:'processing',percent:clamp(fraction*100,0,99),current:clamp(fraction,0,1)*total,total});
      const hasFinished=item=>item.video.ended||item.video.currentTime>=item.duration-.035;
      const finished=mode==='split'?(hasFinished(primary)&&secondStarted&&hasFinished(secondary)):current.video.ended||current.video.currentTime>=(mode==='merge'?current.duration:end)-.035;
      if(finished){
        if(mode==='merge'&&next){current.video.pause();current=next;next=null;checkPlayback=playbackWatchdog();await play(current);continue;}
        if(mode==='loop'&&runs+1<loopCount){runs++;current.video.pause();await seek(current.video,start,signal);checkPlayback=playbackWatchdog();await play(current);continue;}
        break;
      }
      await nextVideoFrame(mode==='split'&&primary.video.ended&&secondStarted?secondary.video:current.video,fps,signal);
    }
    draw(current,mode==='split'&&secondStarted?secondary:null);
    onProgress({stage:'finalizing',description:'Сохраняем видео…'});
    recorder.stop();
    const blob=await awaitMedia(done,{signal,timeoutMs:20000,message:'Не удалось завершить сохранение видео. Попробуйте снова.'});
    ensure(blob.size>0,'Не удалось создать файл: браузер не вернул результат.');
    onProgress({stage:'complete',percent:100,current:total,total});
    const experimentalRequested=options.engine==='webcodecs'||options.engine==='ffmpeg';
    return {blob,ext:extension(mime),type:mime,method:experimentalRequested?'classic-fallback':'classic',
      info:experimentalRequested?'Экспериментальный режим не подошёл для этого файла. Использован обычный экспорт.':''};
  } catch(e){
    if(recorderPack?.recorder.state==='recording'){
      recorderPack.recorder.stop();
      await awaitMedia(recorderPack.done.catch(()=>{}),{timeoutMs:3000}).catch(()=>{});
    }
    // A browser may decode a clip but lack Canvas capture, Web Audio or a
    // compatible MediaRecorder. These composite jobs can still use FFmpeg/WASM.
    if(['merge','split','watermark','vr'].includes(mode)
      &&e?.name!=='AbortError'&&!signal?.aborted){
      for(const track of stream?.getTracks()||[])track.stop();
      await audioCtx?.close().catch(()=>{});
      primary.close();secondary?.close();
      return await compatibilityFallback(files,mode,options,onProgress,signal,e);
    }
    throw e;
  } finally {
    for(const track of stream?.getTracks()||[])track.stop();
    await audioCtx?.close().catch(()=>{});
    primary.close();secondary?.close();
  }
}

export async function frameFromVideo(file, seconds=0, signal){
  let item;
  try{item=await openVideo(file,signal);}
  catch(error){return compatibilityFallback(file,'frame',{seconds},()=>{},signal,error);}
  try {
    onAbort(signal);
    await seek(item.video,clamp(Number(seconds)||0,0,Math.max(0,item.duration-.02)),signal);
    const canvas=document.createElement('canvas');canvas.width=item.width;canvas.height=item.height;
    canvas.getContext('2d').drawImage(item.video,0,0,item.width,item.height);
    const blob=await awaitMedia(new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось сохранить кадр в PNG.')),'image/png')),
      {signal,timeoutMs:20000,message:'Не удалось завершить сохранение PNG. Попробуйте снова.'});
    onAbort(signal);
    return {blob,ext:'png'};
  } finally { item.close(); }
}
export async function inspectVideo(file,signal){
  const container=await inspectContainer(file,signal);
  if(container?.width>0&&container?.height>0&&container?.duration>0)
    return {name:file.name,type:file.type||container.container,size:file.size,
      width:container.width,height:container.height,duration:container.duration,
      videoCodec:container.videoCodec,audioCodec:container.audioCodec,
      modified:file.lastModified};
  const item=await openVideo(file,signal);
  try {return {name:file.name,type:file.type||'неизвестно',size:file.size,width:item.width,height:item.height,duration:item.duration,modified:file.lastModified};}
  finally {item.close();}
}
export async function extractAudio(file,{onProgress=()=>{},signal}={}){
  const fast=await tryFastExtractAudio({file,onProgress,signal});
  if(fast)return fast;
  onProgress({stage:'preparing',description:'Без потерь извлечь звук нельзя. Подготовка аудиокодера…'});
  let item;
  try{item=await openVideo(file,signal);}
  catch(error){return compatibilityFallback(file,'extract-audio',{},onProgress,signal,error);}
  let context=null,pack=null;
  try{
    ensure(typeof AudioContext!=='undefined','Этот браузер не поддерживает извлечение звука.');
    item.video.muted=false;
    context=new AudioContext();
    const destination=context.createMediaStreamDestination();
    const source=context.createMediaElementSource(item.video);source.connect(destination);
    await awaitMedia(context.resume(),{signal,message:'Не удалось подготовить извлечение звука.'});
    pack=recorderFor(destination.stream,{audioOnly:true});
    pack.recorder.start(200);
    await awaitMedia(item.video.play(),{signal,message:'Не удалось запустить видео для извлечения звука.'});
    const checkPlayback=playbackWatchdog();
    while(!item.video.ended&&item.video.currentTime<item.duration-.03){
      onAbort(signal);
      checkPlayback(item.video.currentTime);
      if(item.video.error)throw new Error('Не удалось прочитать звуковую дорожку.');
      onProgress({stage:'processing',description:'Извлечение звука',percent:Math.min(99,item.video.currentTime/item.duration*100),current:item.video.currentTime,total:item.duration});
      await abortableDelay(100,signal);
    }
    onProgress({stage:'finalizing',description:'Сохраняем аудиофайл…'});
    pack.recorder.stop();const blob=await awaitMedia(pack.done,{signal,timeoutMs:20000,message:'Не удалось завершить сохранение звука.'});
    ensure(blob.size>0,'Не удалось создать звуковой файл.');onProgress({stage:'complete',percent:100,current:item.duration,total:item.duration});
    return {blob,ext:extension(pack.mime,true)};
  }catch(e){if(pack?.recorder.state==='recording'){
    pack.recorder.stop();await awaitMedia(pack.done.catch(()=>{}),{timeoutMs:3000}).catch(()=>{});
  }throw e;}
  finally {await context?.close().catch(()=>{});item.close();}
}

async function requestMediaWithAbort(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>{
      if(settled)return;
      settled=true;signal.removeEventListener('abort',abort);
      reject(new DOMException('Отменено','AbortError'));
    };
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    Promise.resolve(promise).then(stream=>{
      // После отмены диалог разрешения может завершиться позднее. Не оставляем камеру включённой.
      if(settled){for(const track of stream.getTracks())track.stop();return;}
      settled=true;signal.removeEventListener('abort',abort);resolve(stream);
    },error=>{
      if(settled)return;
      settled=true;signal.removeEventListener('abort',abort);reject(error);
    });
  });
}

export async function recordDevice(kind,{onStop=()=>{},onProgress=()=>{},onStream=()=>{},signal}={}){
  onProgress({stage:'preparing',description:'Ожидаем разрешение браузера на запись…'});
  ensure(navigator.mediaDevices,'Для записи откройте сайт по HTTPS или на localhost.');
  onAbort(signal);
  const request=kind==='screen'
    ? navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:true})
    : navigator.mediaDevices.getUserMedia({video:true,audio:true}).catch(async e=>{
      if(e.name==='NotFoundError'){onAbort(signal);return navigator.mediaDevices.getUserMedia({video:true,audio:false});}
      throw e;
    });
  const stream=await requestMediaWithAbort(request,signal);
  let recorder,ticker=null,started=0;
  try {
    onAbort(signal);
    onStream(stream);
    const pack=recorderFor(stream,{videoBitsPerSecond:2500000});recorder=pack.recorder;
    let stop;
    const stopPromise=new Promise(resolve=>{stop=resolve;});
    onStop(stop);
    for(const track of stream.getVideoTracks())track.addEventListener('ended',stop,{once:true});
    recorder.start(250);
    started=performance.now();
    const report=()=>onProgress({stage:'recording',elapsedSeconds:(performance.now()-started)/1000});
    report();ticker=setInterval(report,250);
    if(signal?.aborted)onAbort(signal);
    let abortWait;
    try{
      await Promise.race([
        stopPromise,
        pack.done.then(()=>{throw new Error('Запись прервалась. Проверьте доступ к камере, экрану или вкладке.');}),
        new Promise(resolve=>{abortWait=resolve;signal?.addEventListener('abort',abortWait,{once:true});})
      ]);
    }finally{if(abortWait)signal?.removeEventListener('abort',abortWait);}
    onAbort(signal);
    clearInterval(ticker);ticker=null;
    onProgress({stage:'finalizing',description:'Сохраняем запись…',elapsedSeconds:(performance.now()-started)/1000});
    if(recorder.state==='recording')recorder.stop();
    const blob=await awaitMedia(pack.done,{signal,timeoutMs:20000,message:'Не удалось завершить сохранение записи.'});
    onAbort(signal);
    ensure(blob.size>0,'Запись пуста. Попробуйте начать её заново.');
    return {blob,ext:extension(pack.mime)};
  }finally {if(ticker!==null)clearInterval(ticker);if(recorder?.state==='recording')recorder.stop();for(const track of stream.getTracks())track.stop();onStream(null);onStop(null);}
}
