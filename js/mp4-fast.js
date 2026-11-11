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
// Refuse a fast success when the output container reports missing samples,
// changed track counts or a duration outside the requested range. A usable
// fallback is preferable to presenting a damaged output as finished.
function validCopy(source,out,expectedDuration,toleranceMs=160){
  if(!out?.tracks?.length||!Number.isFinite(out.durationMs))return false;
  // The file may contain keyframe pre-roll that its MP4 edit list hides.
  // The raw sample/media duration is therefore NOT the visible clip duration.
  // Validate the movie edit-list duration of the output video track instead.
  const video=out.tracks.find(t=>t.handler==='vide');
  const visibleMs=video?.edits?.length
    ?video.edits.reduce((sum,edit)=>sum+edit.segDur,0)/(out.movieTs||1000)*1000
    :out.durationMs;
  if(!Number.isFinite(visibleMs)||Math.abs(visibleMs-expectedDuration)>toleranceMs)return false;
  for(const handler of ['vide','soun']){
    const inputTracks=(source.tracks||[]).filter(t=>t.handler===handler);
    const outputTracks=out.tracks.filter(t=>t.handler===handler);
    if(inputTracks.length!==outputTracks.length)return false;
    if(outputTracks.some(t=>!(t.samples>0)))return false;
  }
  return true;
}

export async function tryFastMp4({files,file=files?.[0],mode,options={},onProgress=()=>{},signal}){
  if(!file?.size||!['mute','speed','trim','merge','loop','volume','crop','blur'].includes(mode))return null;
  if(String(options.resolution ?? options.width ?? 'original')!=='original')return null;
  if(mode==='merge' && (!files?.[1]||!validMp4(file)||!validMp4(files[1])))return null;
  if(mode==='loop' && (!validMp4(file)&&!validWebm(file)))return null;
  const unchanged=(mode==='volume'&&Number(options.gain)===1&&options.audio!=='off')
    ||(mode==='crop'&&Number(options.crop)===0)
    ||(mode==='blur'&&Number(options.blur)===0)
    ||(mode==='speed'&&Number(options.speed)===1)
    ||(mode==='loop'&&Number(options.loops)===1);
  if(['volume','crop','blur'].includes(mode)&&!unchanged)return null;
  if(unchanged&&!validMp4(file)&&!validWebm(file))return null;
  if(mode==='speed' && (!validMp4(file)||!Number.isFinite(Number(options.speed))||Number(options.speed)<=0))return null;
  if(mode==='mute'&&!validMp4(file))return null;
  if(mode==='trim'&&!validMp4(file)&&!validWebm(file))return null;
  abortCheck(signal);
  try{
    // A no-op still needs a valid container: never label corrupt data a successful copy.
    if(unchanged){
      const isMp4=validMp4(file);
      const engine=isMp4?await tracks():await webmCopy();
      const metadata=await engine.inspect(file);
      abortCheck(signal);
      const hasVideo=isMp4?metadata.tracks.some(t=>t.handler==='vide'):!!metadata.videoTrack;
      if(!hasVideo)return null;
      done(onProgress,'Файл не требует изменений — оригинал сохранён без перекодирования.');
      return successful(file,isMp4?'mp4':'webm','copy');
    }
    if(mode==='loop'){
      const loops=Math.floor(Number(options.loops)||2);
      if(!Number.isFinite(loops)||loops<2||loops>10||!validMp4(file))return null;
      const track=await tracks();abortCheck(signal);
      const input=await track.inspect(file);abortCheck(signal);
      const videos=input.tracks.filter(t=>t.handler==='vide');
      const audios=input.tracks.filter(t=>t.handler==='soun');
      if(videos.length!==1||audios.length>1||!(input.durationSec>0))return null;
      const engine=await mp4Copy();abortCheck(signal);
      onProgress({stage:'preparing',description:'Повтор MP4 без перекодирования кадров и звука…'});
      const clips=Array.from({length:loops},()=>({video:file,audio:audios.length?file:null}));
      const output=await engine.concat({clips,brand:'mp4',name:'loop.mp4'});
      abortCheck(signal);
      if(!output?.size||output.concatInfo?.clips?.length!==loops)return null;
      const actual=await engine.inspect(output);abortCheck(signal);
      const expected=input.durationSec*loops*1000;
      if(!Number.isFinite(actual.durationMs)||Math.abs(actual.durationMs-expected)>Math.max(250,expected*.04)
        ||actual.tracks.filter(t=>t.handler==='vide').length!==1
        ||actual.tracks.filter(t=>t.handler==='soun').length!==audios.length)return null;
      done(onProgress,'Повтор готов без перекодирования.');
      return successful(output,'mp4','lossless-loop');
    }
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
      if(isMp4){
        const resultMeta=await engine.inspect(out);
        abortCheck(signal);
        if(!validCopy(meta,resultMeta,(end-start)*1000))return null;
      }
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
      if(info.some(x=>x.tracks.filter(t=>t.handler==='vide').length!==1 || x.tracks.filter(t=>t.handler==='soun').length>1))return null;
      onProgress({stage:'preparing',description:'Склейка MP4 без перекодирования…'});
      const out=await engine.concat({clips:files.slice(0,2).map(x=>({video:x,audio:flags[0]?x:null})),brand:'mp4',name:'merged.mp4'});
      abortCheck(signal);
      if(!out?.size)throw new Error('Не удалось объединить видео.');
      const outputMeta=await engine.inspect(out);
      abortCheck(signal);
      const expectedMs=info.every(x=>x.durationSec>0)
        ?info.reduce((sum,item)=>sum+item.durationSec*1000,0)
        :out.concatInfo?.durationMs;
      // For repeated source videos, the output duration may differ slightly
      // due to AAC priming and the final video sample duration.
      if(!Number.isFinite(outputMeta.durationMs)||Math.abs(outputMeta.durationMs-expectedMs)>Math.max(200,expectedMs*.04)
        ||outputMeta.tracks.filter(t=>t.handler==='vide').length!==1
        ||outputMeta.tracks.filter(t=>t.handler==='soun').length!==Number(flags[0]))return null;
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
      const outputMeta=await engine.inspect(new File([out.blob],file.name,{type:'video/mp4'}));
      abortCheck(signal);
      if(outputMeta.tracks.some(t=>t.handler==='soun')||outputMeta.tracks.filter(t=>t.handler==='vide').length!==details.tracks.filter(t=>t.handler==='vide').length
        ||(details.durationSec>0&&Math.abs(outputMeta.durationSec-details.durationSec)>.20))return null;
      done(onProgress,'Звуковая дорожка удалена без перекодирования.');
      return successful(out.blob,'mp4','track-remux');
    }
    // Altering just video timestamps while leaving audio intact causes A/V drift.
    if(details.tracks.some(x=>x.handler==='soun'))return null;
    onProgress({stage:'preparing',description:'Изменение временных меток MP4 без перекодирования…'});
    const result=await engine.retime(file,Number(options.speed),{keepOtherTracks:false});
    abortCheck(signal);
    if(!result?.blob?.size)throw new Error('Быстрый MP4-движок вернул пустой файл.');
    const outputMeta=await engine.inspect(new File([result.blob],file.name,{type:'video/mp4'}));
    abortCheck(signal);
    if(outputMeta.tracks.filter(t=>t.handler==='vide').length!==details.tracks.filter(t=>t.handler==='vide').length
      ||outputMeta.tracks.some(t=>t.handler==='soun')
      ||(details.durationSec>0&&Math.abs(outputMeta.durationSec-details.durationSec/Number(options.speed))>.20))return null;
    done(onProgress,'Скорость изменена без перекодирования.');
    return successful(result.blob,'mp4','timestamp-retime');
  }catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw error;
    console.warn('Быстрый экспорт недоступен, используем обычную обработку:',error);
    onProgress({stage:'preparing',description:'Быстрый путь недоступен. Подготовка обычного экспорта…'});
    return null;
  }
}

/**
 * Preserve the original MP4 audio samples when extracting sound. For codecs
 * outside the MP4 audio family, the caller falls back to Web Audio/MediaRecorder.
 */
export async function tryFastExtractAudio({file,onProgress=()=>{},signal}={}){
  if(!validMp4(file))return null;
  abortCheck(signal);
  try{
    const engine=await tracks();abortCheck(signal);
    const input=await engine.inspect(file);abortCheck(signal);
    const videos=input.tracks.filter(t=>t.handler==='vide');
    const audios=input.tracks.filter(t=>t.handler==='soun');
    if(!videos.length||audios.length!==1||!['aac','alac','mp4a'].includes(audios[0].codec))return null;
    onProgress({stage:'preparing',description:'Извлечение оригинальной аудиодорожки без перекодирования…'});
    const result=await engine.remux(file,{keepHandlers:['soun'],brand:'M4A ',mime:'audio/mp4'});
    abortCheck(signal);
    if(!result?.blob?.size)return null;
    const output=await engine.inspect(new File([result.blob],'audio.m4a',{type:'audio/mp4'}));
    abortCheck(signal);
    const resultAudios=output.tracks.filter(t=>t.handler==='soun');
    if(output.tracks.some(t=>t.handler==='vide')||resultAudios.length!==1
      ||resultAudios[0].codec!==audios[0].codec
      ||(input.durationSec>0&&Math.abs(output.durationSec-input.durationSec)>.35))return null;
    done(onProgress,'Оригинальная аудиодорожка сохранена без перекодирования.');
    return {blob:result.blob,ext:'m4a',type:'audio/mp4',fast:true,method:'audio-remux',info:'Сохранён исходный аудиокодек и качество звука.'};
  }catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw error;
    console.warn('Извлечение звука без перекодирования недоступно:',error);
    return null;
  }
}
