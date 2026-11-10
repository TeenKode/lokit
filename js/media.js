// Браузерный движок обработки пользовательских файлов. Не использует серверные API.
const VIDEO_TYPES = [
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8', 'video/webm', 'video/mp4'
];
const VIDEO_SILENT_TYPES=['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm','video/mp4'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function ensure(value, message) { if (!value) throw new Error(message); }
function onAbort(signal) { if (signal?.aborted) throw new DOMException('Отменено', 'AbortError'); }
function filename(file) { return file?.name || 'видео'; }
function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
export function outputName(file, suffix, ext) {
  return `${filename(file).replace(/\.[^.]+$/, '')}-${suffix}.${ext}`;
}
function mimeChoice(types) { return types.find(x => MediaRecorder.isTypeSupported(x)) || ''; }

export async function openVideo(file,signal) {
  onAbort(signal);
  ensure(file instanceof File, 'Сначала выберите видеофайл.');
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.src = url;
  video.preload = 'auto'; video.playsInline = true;
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  try {
    await new Promise((resolve,reject)=>{
      let finished=false;
      const timeout=setTimeout(()=>finish(new Error('Браузер не смог открыть видео. Проверьте формат файла.')),18000);
      const loaded=()=>finish();
      const failure=()=>finish(new Error('Неподдерживаемый или повреждённый видеофайл.'));
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
    ensure(video.videoWidth && video.videoHeight, 'Не удалось определить размер кадра.');
    ensure(Number.isFinite(video.duration) && video.duration > 0, 'Не удалось определить длительность видео.');
    return { video, url, duration:video.duration, width:video.videoWidth, height:video.videoHeight,
      close() { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); } };
  } catch (error) { video.remove(); URL.revokeObjectURL(url); throw error; }
}

async function seek(video, at, signal) {
  onAbort(signal);
  const same = Math.abs(video.currentTime-at)<.015;
  if (same && video.readyState>=2) return;
  await new Promise((resolve,reject)=>{
    const eventName=same?'loadeddata':'seeked';
    const timeout = setTimeout(()=>{done();reject(new Error('Не удалось загрузить выбранный кадр.'));},12000);
    const aborted = () => {done();reject(new DOMException('Отменено','AbortError'));};
    const ok = () => {done();resolve();};
    const done = () => {clearTimeout(timeout);video.removeEventListener(eventName,ok);signal?.removeEventListener('abort',aborted);};
    video.addEventListener(eventName,ok,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    if(!same)video.currentTime=at;
    else if(video.readyState>=2)ok();
  });
}

function renderFit(ctx, video, x, y, width, height) {
  if (!video || video.readyState < 2) return;
  const scale = Math.min(width/video.videoWidth,height/video.videoHeight);
  const w=video.videoWidth*scale,h=video.videoHeight*scale;
  ctx.drawImage(video,x+(width-w)/2,y+(height-h)/2,w,h);
}
function render(ctx, a, b, mode, options, outWidth, outHeight) {
  const w=outWidth,h=outHeight;
  ctx.save();ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);
  if (mode==='filter') ctx.filter=String(options.filter||'none');
  if (mode==='blur') ctx.filter=`blur(${clamp(Number(options.blur)||4,0,35)}px)`;
  switch(mode) {
    case 'flip-h':ctx.translate(w,0);ctx.scale(-1,1);ctx.drawImage(a,0,0,w,h);break;
    case 'flip-v':ctx.translate(0,h);ctx.scale(1,-1);ctx.drawImage(a,0,0,w,h);break;
    case 'rotate-90':ctx.translate(w,0);ctx.rotate(Math.PI/2);ctx.drawImage(a,0,0,h,w);break;
    case 'rotate-180':ctx.translate(w,h);ctx.rotate(Math.PI);ctx.drawImage(a,0,0,w,h);break;
    case 'rotate-270':ctx.translate(0,h);ctx.rotate(-Math.PI/2);ctx.drawImage(a,0,0,h,w);break;
    case 'crop':{
      const p=clamp(Number(options.crop)||10,0,40)/100;
      ctx.drawImage(a,a.videoWidth*p,a.videoHeight*p,a.videoWidth*(1-2*p),a.videoHeight*(1-2*p),0,0,w,h);
      break;
    }
    case 'vr':renderFit(ctx,a,0,0,w/2,h);renderFit(ctx,a,w/2,0,w/2,h);break;
    case 'split':renderFit(ctx,a,0,0,w/2,h);renderFit(ctx,b,w/2,0,w/2,h);break;
    default: renderFit(ctx,a,0,0,w,h);
  }
  ctx.restore();
  if(mode==='watermark'){
    const label=String(options.text||'Моё видео').slice(0,80);
    ctx.save();ctx.font=`700 ${Math.max(14,Math.floor(w/27))}px system-ui,sans-serif`;
    ctx.textAlign='right';ctx.textBaseline='bottom';ctx.shadowColor='#000';ctx.shadowBlur=6;
    ctx.fillStyle='#fff';ctx.fillText(label,w-22,h-18,w-40);ctx.restore();
  }
}
function canvasSize(info, mode, options) {
  const target=clamp(Number(options.width)||720,240,1920);
  let w=info.width,h=info.height;
  if (mode==='crop') {const p=clamp(Number(options.crop)||10,0,40)/100;w*=1-2*p;h*=1-2*p;}
  if(['rotate-90','rotate-270'].includes(mode)) [w,h]=[h,w];
  if(['split','vr'].includes(mode)) {w=16;h=9;}
  const factor=Math.min(1,target/Math.max(w,h));
  if(mode==='split'||mode==='vr') return {width:even(target),height:even(target*9/16)};
  return {width:even(w*factor),height:even(h*factor)};
}
function recorderFor(stream, {videoBitsPerSecond=2500000,audioOnly=false}={}) {
  ensure(typeof MediaRecorder!=='undefined', 'Этот браузер не поддерживает запись MediaRecorder.');
  const mime=mimeChoice(audioOnly?AUDIO_TYPES:stream.getAudioTracks().length?VIDEO_TYPES:VIDEO_SILENT_TYPES);
  ensure(mime, 'Браузер не поддерживает экспорт аудио/видео в доступный формат.');
  const recorder=new MediaRecorder(stream, audioOnly?{mimeType:mime}:{mimeType:mime,videoBitsPerSecond});
  const chunks=[];
  recorder.addEventListener('dataavailable',e=>{if(e.data?.size)chunks.push(e.data);});
  const done=new Promise((resolve,reject)=>{
    recorder.addEventListener('stop',()=>resolve(new Blob(chunks,{type:recorder.mimeType||mime})),{once:true});
    recorder.addEventListener('error',e=>reject(e.error||new Error('Ошибка кодирования видео.')),{once:true});
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
export async function transformVideo({files, mode='convert', options={}, onProgress=()=>{}, signal}){
  onProgress({stage:'preparing',description:'Чтение метаданных видео…'});
  const primary=await openVideo(files[0],signal);
  let secondary=null, audioCtx=null, stream=null, recorderPack=null;
  try {
    onAbort(signal);
    if(['merge','split'].includes(mode)) {
      onProgress({stage:'preparing',description:'Подготовка второго видео…'});
      ensure(files[1], 'Этот инструмент требует два видеофайла.');secondary=await openVideo(files[1],signal);
    }
    const {width,height}=canvasSize(primary,mode,options);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{alpha:false});
    ensure(ctx && typeof canvas.captureStream==='function','Обработка через Canvas недоступна в этом браузере.');
    const fps=clamp(Number(options.fps)||25,5,60);
    stream=canvas.captureStream(fps);
    const videos=secondary&&mode==='merge'?[primary.video,secondary.video]:[primary.video];
    const includeAudio=mode!=='mute' && options.audio!=='off';
    if(includeAudio && typeof AudioContext!=='undefined'){
      try {
        audioCtx=new AudioContext();
        connectAudio(audioCtx,videos,stream,mode==='volume'?clamp(Number(options.gain)||1,0,3):1);
        await audioCtx.resume();
      } catch(e){console.warn('Звуковую дорожку добавить не удалось:',e);await audioCtx?.close().catch(()=>{});audioCtx=null;}
    }
    // Для split второй ролик НЕ подключён к AudioContext: глушим его
    // напрямую, иначе его звук может играть через динамики устройства.
    primary.video.muted=!audioCtx;
    if(secondary)secondary.video.muted=!audioCtx || mode==='split';
    const rate=mode==='speed'?clamp(Number(options.speed)||1,0.25,4):1;
    primary.video.playbackRate=rate;
    const start=mode==='trim'?clamp(Number(options.start)||0,0,primary.duration):0;
    const end=mode==='trim'?clamp(Number(options.end)||primary.duration,0,primary.duration):primary.duration;
    ensure(end>start,'Конечное время должно быть больше начального.');
    const loopCount=mode==='loop'?clamp(Math.floor(Number(options.loops)||2),1,10):1;
    const total=mode==='merge'?primary.duration+secondary.duration:mode==='split'?Math.max(primary.duration,secondary.duration):(end-start)*loopCount;
    const bitrate=mode==='compress'?clamp(Number(options.bitrate)||650000,150000,5000000):clamp(Number(options.bitrate)||2500000,200000,15000000);
    recorderPack=recorderFor(stream,{videoBitsPerSecond:bitrate});
    const {recorder,done,mime}=recorderPack;
    onProgress({stage:'preparing',description:'Подготовка видеокодера…'});
    const draw=(first,second)=>render(ctx,first.video,second?.video,mode,options,width,height);
    await seek(primary.video,start,signal);
    draw(primary,secondary);
    recorder.start(200);
    let runs=0,current=primary,next=secondary;
    const play=async item=>{onAbort(signal);try {await item.video.play();} catch(e) {throw new Error('Браузер заблокировал воспроизведение. Нажмите «Запустить» ещё раз либо проверьте формат файла.');}};
    await play(primary);
    if(mode==='split') await play(secondary);
    while(true){
      onAbort(signal);
      draw(current,mode==='split'?secondary:null);
      let fraction;
      if(mode==='merge')fraction=(current===primary?primary.video.currentTime:primary.duration+secondary.video.currentTime)/total;
      else if(mode==='split')fraction=Math.max(primary.video.currentTime,secondary.video.currentTime)/total;
      else fraction=(runs*(end-start)+Math.min(end-start,Math.max(0,current.video.currentTime-start)))/total;
      onProgress({stage:'processing',percent:clamp(fraction*100,0,99),current:clamp(fraction,0,1)*total,total});
      const finished=mode==='split'?(primary.video.ended&&secondary.video.ended):current.video.ended||current.video.currentTime>=(mode==='merge'?current.duration:end)-.035;
      if(finished){
        if(mode==='merge'&&next){current.video.pause();current=next;next=null;await play(current);continue;}
        if(mode==='loop'&&runs+1<loopCount){runs++;current.video.pause();await seek(current.video,start,signal);await play(current);continue;}
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.max(25,Math.round(1000/fps))));
    }
    draw(current,mode==='split'?secondary:null);
    onProgress({stage:'finalizing',description:'Завершение кодирования видео…'});
    recorder.stop();
    const blob=await done;
    ensure(blob.size>0,'Файл не получился: браузер не выдал записанных данных.');
    onProgress({stage:'complete',percent:100,current:total,total});
    return {blob,ext:extension(mime),type:mime};
  } catch(e){
    if(recorderPack?.recorder.state==='recording'){recorderPack.recorder.stop();await recorderPack.done.catch(()=>{});}
    throw e;
  } finally {
    for(const track of stream?.getTracks()||[])track.stop();
    await audioCtx?.close().catch(()=>{});
    primary.close();secondary?.close();
  }
}

export async function frameFromVideo(file, seconds=0, signal){
  const item=await openVideo(file,signal);
  try {
    onAbort(signal);
    await seek(item.video,clamp(Number(seconds)||0,0,Math.max(0,item.duration-.02)),signal);
    const canvas=document.createElement('canvas');canvas.width=item.width;canvas.height=item.height;
    canvas.getContext('2d').drawImage(item.video,0,0,item.width,item.height);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось создать PNG.')),'image/png'));
    onAbort(signal);
    return {blob,ext:'png'};
  } finally { item.close(); }
}
export async function inspectVideo(file,signal){
  const item=await openVideo(file,signal);
  try {return {name:file.name,type:file.type||'неизвестно',size:file.size,width:item.width,height:item.height,duration:item.duration,modified:file.lastModified};}
  finally {item.close();}
}
export async function extractAudio(file,{onProgress=()=>{},signal}={}){
  onProgress({stage:'preparing',description:'Чтение видео и подготовка звуковой дорожки…'});
  const item=await openVideo(file,signal);let context=null,pack=null;
  try{
    ensure(typeof AudioContext!=='undefined','Web Audio API не поддерживается.');
    item.video.muted=false;
    context=new AudioContext();
    const destination=context.createMediaStreamDestination();
    const source=context.createMediaElementSource(item.video);source.connect(destination);
    await context.resume();
    pack=recorderFor(destination.stream,{audioOnly:true});
    pack.recorder.start(200);
    await item.video.play();
    while(!item.video.ended){
      onAbort(signal);onProgress({stage:'processing',description:'Извлечение звука',percent:Math.min(99,item.video.currentTime/item.duration*100),current:item.video.currentTime,total:item.duration});
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    onProgress({stage:'finalizing',description:'Сохранение аудиофайла…'});
    pack.recorder.stop();const blob=await pack.done;
    ensure(blob.size>0,'Звук не был записан.');onProgress({stage:'complete',percent:100,current:item.duration,total:item.duration});
    return {blob,ext:extension(pack.mime,true)};
  }catch(e){if(pack?.recorder.state==='recording'){pack.recorder.stop();await pack.done.catch(()=>{});}throw e;}
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

export async function recordDevice(kind,{onStop=()=>{},onProgress=()=>{},signal}={}){
  onProgress({stage:'preparing',description:'Ожидание разрешения на запись…'});
  ensure(navigator.mediaDevices,'Запись доступна только на HTTPS или localhost.');
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
      await Promise.race([stopPromise,new Promise(resolve=>{abortWait=resolve;signal?.addEventListener('abort',abortWait,{once:true});})]);
    }finally{if(abortWait)signal?.removeEventListener('abort',abortWait);}
    onAbort(signal);
    clearInterval(ticker);ticker=null;
    onProgress({stage:'finalizing',description:'Сохранение записи…',elapsedSeconds:(performance.now()-started)/1000});
    if(recorder.state==='recording')recorder.stop();
    const blob=await pack.done;
    onAbort(signal);
    ensure(blob.size>0,'Запись не содержит данных.');
    return {blob,ext:extension(pack.mime)};
  }finally {if(ticker!==null)clearInterval(ticker);if(recorder?.state==='recording')recorder.stop();for(const track of stream.getTracks())track.stop();onStop(null);}
}
