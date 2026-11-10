/**
 * Lossless MP4/WebM operations adapted from the user's supplied source archive.
 * Operations modify container metadata/sample ranges rather than re-encode video.
 * Unsupported combinations return null and the caller uses Canvas/MediaRecorder.
 */
const validMp4=file=>file?.size>0&&/\.(mp4|m4v)$/i.test(file.name||'');
const validWebm=file=>file?.size>0&&/\.webm$/i.test(file.name||'');
const abortCheck=signal=>{if(signal?.aborted)throw new DOMException('Отменено','AbortError');};
let trackPromise,copyPromise,webmPromise;
async function tracks(){
  trackPromise ||= import('./vendor/mp4-track-remux.js')
    .then(()=>{if(!globalThis.MP4TrackRemux)throw new Error('MP4TrackRemux не загружен.');return globalThis.MP4TrackRemux;})
    .catch(error=>{trackPromise=null;throw error;});
  return trackPromise;
}
async function mp4Copy(){
  copyPromise ||= (async()=>{
    await import('./vendor/mp4-flatten.js');
    await import('./vendor/mp4-copy-trim.js');
    if(!globalThis.Mp4CopyTrim)throw new Error('Mp4CopyTrim не загружен.');
    return globalThis.Mp4CopyTrim;
  })().catch(error=>{copyPromise=null;throw error;});
  return copyPromise;
}
async function webmCopy(){
  webmPromise ||= import('./vendor/webm-copy-trim.js')
    .then(()=>{if(!globalThis.WebmCopyTrim)throw new Error('WebmCopyTrim не загружен.');return globalThis.WebmCopyTrim;})
    .catch(error=>{webmPromise=null;throw error;});
  return webmPromise;
}
/**
 * For WebM exact trims, use fast copy only if the start is within 50 ms of a
 * keyframe. Otherwise use re-encoding to avoid surprising early frames.
 */
const almostEqual=(a,b)=>Math.abs(a-b)<0.05;
const successful=(blob,ext,method,info='')=>({blob,ext,type:ext==='mp4'?'video/mp4':'video/webm',fast:true,method,info});
const done=(onProgress,description)=>onProgress({stage:'complete',percent:100,description});

export async function tryFastMp4({files,file=files?.[0],mode,options={},onProgress=()=>{},signal}){
  if(!file?.size||!['mute','speed','trim','merge'].includes(mode))return null;
  if(String(options.resolution ?? options.width ?? 'original')!=='original')return null;
  if(mode==='merge' && (!files?.[1]||!validMp4(file)||!validMp4(files[1])))return null;
  if(mode==='speed' && (!validMp4(file)||!Number.isFinite(Number(options.speed))||Number(options.speed)<=0||Number(options.speed)===1))return null;
  if(mode==='mute'&&!validMp4(file))return null;
  if(mode==='trim'&&!validMp4(file)&&!validWebm(file))return null;
  abortCheck(signal);
  try{
    if(mode==='trim'){
      const isMp4=validMp4(file);
      onProgress({stage:'preparing',description:'Подготовка обрезки без перекодирования…'});
      const engine=isMp4?await mp4Copy():await webmCopy();
      abortCheck(signal);
      const meta=await engine.inspect(file);
      abortCheck(signal);
      const duration=isMp4?meta.durationMs/1000:meta.durationMs/1000;
      if(!Number.isFinite(duration)||duration<=0)return null;
      const start=Math.max(0,Math.min(duration,Number(options.start)||0));
      const end=Math.max(0,Math.min(duration,Number(options.end)||duration));
      if(!(end>start))throw new Error('Конечное время должно быть больше начального.');
      if(start===0&&almostEqual(end,duration)){
        done(onProgress,'Изменения не требуются, файл сохранён без перекодирования.');
        return successful(file,isMp4?'mp4':'webm','copy');
      }
      let warning='';
      if(!isMp4){
        const keys=await engine.keyframeTimes(file);
        abortCheck(signal);
        const prior=(keys||[]).filter(t=>t<=start+0.001).at(-1);
        if(start>0 && (!Number.isFinite(prior)||!almostEqual(prior,start))){
          if(options.cutMode!=='keyframe')return null;
          warning=`Начало с ближайшего ключевого кадра (${(prior??0).toFixed(2)} с вместо ${start.toFixed(2)} с).`;
        }
      }
      onProgress({stage:'preparing',description:'Сборка видео из исходных кадров без потери качества…'});
      const out=isMp4
        ?await engine.run(file,start,end,{exact:true})
        :await engine.run(file,start,end);
      abortCheck(signal);
      if(!out?.size)throw new Error('Не удалось собрать обрезанное видео.');
      if(!isMp4&&options.cutMode!=='keyframe'&&!almostEqual((out.trimInfo?.startMs??0)/1000,start))return null;
      done(onProgress,'Обрезка готова без перекодирования.');
      return successful(out,isMp4?'mp4':'webm','lossless-trim',warning);
    }
    if(mode==='merge'){
      const engine=await mp4Copy();abortCheck(signal);
      const track=await tracks();abortCheck(signal);
      const info=await Promise.all(files.slice(0,2).map(x=>track.inspect(x)));
      abortCheck(signal);
      const flags=info.map(x=>x.tracks.some(t=>t.handler==='soun'));
      if(flags[0]!==flags[1])return null; // never fabricate a silent track from audible frames
      onProgress({stage:'preparing',description:'Склейка MP4 без перекодирования…'});
      const out=await engine.concat({clips:files.slice(0,2).map(x=>({video:x,audio:flags[0]?x:null})),brand:'mp4',name:'merged.mp4'});
      abortCheck(signal);
      if(!out?.size)throw new Error('Не удалось объединить видео.');
      done(onProgress,'Два MP4 объединены без перекодирования.');
      return successful(out,'mp4','lossless-merge');
    }
    const engine=await tracks();abortCheck(signal);
    onProgress({stage:'preparing',description:'Анализ дорожек MP4 без перекодирования…'});
    const details=await engine.inspect(file);abortCheck(signal);
    if(!details?.tracks?.some(x=>x.handler==='vide'))return null;
    if(mode==='mute'){
      if(!details.tracks.some(x=>x.handler==='soun')){
        done(onProgress,'У файла уже нет звуковой дорожки.');
        return successful(file,'mp4','copy');
      }
      onProgress({stage:'preparing',description:'Удаление аудиодорожки без перекодирования…'});
      const out=await engine.dropAudio(file);abortCheck(signal);
      if(!out?.blob?.size)throw new Error('Быстрый MP4-движок вернул пустой файл.');
      done(onProgress,'Звуковая дорожка удалена без перекодирования.');
      return successful(out.blob,'mp4','track-remux');
    }
    // Altering just video timestamps while leaving audio intact causes A/V drift.
    if(details.tracks.some(x=>x.handler==='soun'))return null;
    onProgress({stage:'preparing',description:'Изменение временных меток MP4 без перекодирования…'});
    const result=await engine.retime(file,Number(options.speed),{keepOtherTracks:false});
    abortCheck(signal);
    if(!result?.blob?.size)throw new Error('Быстрый MP4-движок вернул пустой файл.');
    done(onProgress,'Скорость изменена без перекодирования.');
    return successful(result.blob,'mp4','timestamp-retime');
  }catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw error;
    console.warn('Быстрый экспорт недоступен, используем обычную обработку:',error);
    onProgress({stage:'preparing',description:'Быстрый путь недоступен. Подготовка обычного экспорта…'});
    return null;
  }
}
