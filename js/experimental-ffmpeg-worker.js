/* Optional compatibility fallback for formats not decoded by HTMLVideoElement.
 * The single-thread FFmpeg core is loaded only on demand. Untrusted file names
 * never become command options; all user numbers/filters are clamped or mapped.
 */
function bounded(value,min,max,fallback){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}
function filterFor(mode,options){
  switch(mode){
    case 'flip-h': return 'hflip';
    case 'flip-v': return 'vflip';
    case 'rotate-90': return 'transpose=1';
    case 'rotate-180': return 'hflip,vflip';
    case 'rotate-270': return 'transpose=2';
    case 'blur': {
      const radius=Math.round(bounded(options.blur,0,35,5));
      return radius?'boxblur='+radius+':1':null;
    }
    case 'crop': {
      const edge=bounded(options.crop,0,40,10)/100;
      return edge?'crop=trunc(iw*'+(1-2*edge)+'/2)*2:trunc(ih*'+(1-2*edge)+'/2)*2':null;
    }
    case 'filter': {
      const choices={
        'grayscale(1)':'hue=s=0',
        'sepia(1)':'colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131',
        'contrast(1.4)':'eq=contrast=1.4',
        'brightness(1.3)':'eq=brightness=0.15',
        'saturate(1.6)':'eq=saturation=1.6',
        'invert(1)':'negate'
      };
      if(!choices[options.filter])throw new Error('Неподдерживаемый фильтр FFmpeg.');
      return choices[options.filter];
    }
    case 'speed':return 'setpts=PTS/'+bounded(options.speed,.25,4,1);
    default:return null;
  }
}
function audioFilterFor(mode,options){
  if(mode==='volume')return 'volume='+bounded(options.gain,0,3,1);
  if(mode!=='speed')return null;
  let speed=bounded(options.speed,.25,4,1);
  const parts=[];
  while(speed<.5){parts.push('atempo=0.5');speed*=2;}
  while(speed>2){parts.push('atempo=2');speed/=2;}
  parts.push('atempo='+speed);
  return parts.join(',');
}

// Standardized output is needed only when independent video streams have
// incompatible codecs, dimensions, frame rates or audio layouts.
function geometry(options,split=false){
  let w=bounded(options.targetWidth,2,1920,640),h=bounded(options.targetHeight,2,1080,360);
  if(split){const side=Math.min(w,h);w=Math.round(side*16/9);h=side;}
  const resolution=Number(options.resolution);
  if(Number.isInteger(resolution)&&resolution>=144&&resolution<=2160){
    const scale=Math.min(1,resolution/Math.min(w,h));
    w*=scale;h*=scale;
  }
  return {width:Math.max(2,Math.round(w/2)*2),height:Math.max(2,Math.round(h/2)*2)};
}
const safeExt=name=>/\.([a-z0-9]{2,5})$/i.exec(name||'')?.[1]?.toLowerCase()||'bin';
function encoderArgs(args,{audio=true}={}){
  args.push('-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-crf','24');
  if(audio)args.push('-c:a','aac','-ar','48000','-ac','2','-b:a','160k');
  args.push('-movflags','+faststart');
  return args;
}
function succeeded(core,args){
  const result=core.exec(...args);
  const exit=typeof result==='number'?result:core.ret;
  return exit===0;
}
function requireExec(core,args,label){
  if(!succeeded(core,args))throw new Error('FFmpeg: '+label+' завершилось с ошибкой.');
}
function audioExists(core,source){
  // A 1 ms probe avoids decoding a whole movie and works even when there is no
  // FFprobe executable in the WASM build.
  try{
    return succeeded(core,['-hide_banner','-loglevel','error','-nostdin','-i',source,
      '-map','0:a:0','-t','0.001','-f','null','-']);
  }catch{return false;}
}
function runMerge(core,inputs,options){
  if(inputs.length!==2)throw new Error('Для склейки требуются два видео.');
  const {width,height}=geometry(options),sources=[];
  for(let i=0;i<2;i++){
    const source=inputs[i],dest='lokit-clip-'+i+'.mp4',audio=audioExists(core,source);
    const args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',source];
    if(!audio)args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map','0:v:0','-map',audio?'0:a:0':'1:a:0',
      '-vf','scale='+width+':'+height+':force_original_aspect_ratio=decrease:flags=bicubic,pad='+
        width+':'+height+':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30',
      '-af',audio?'aresample=async=1:first_pts=0,apad':'anull',
      '-shortest','-r','30');
    encoderArgs(args);
    args.push(dest);
    requireExec(core,args,'подготовка ролика '+(i+1));
    sources.push(dest);
  }
  // Each clip is now H.264/AAC at identical geometry and timebase. Concatenate
  // the normalized bitstreams losslessly, so there is only one video encode.
  const list='file '+String.fromCharCode(39)+sources[0]+String.fromCharCode(39)+'\n'
    +'file '+String.fromCharCode(39)+sources[1]+String.fromCharCode(39)+'\n';
  core.FS.writeFile('lokit-concat.txt',new TextEncoder().encode(list));
  requireExec(core,['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','concat','-safe','0','-i','lokit-concat.txt',
    '-map','0:v:0','-map','0:a:0','-c','copy','-movflags','+faststart','lokit-output.mp4'],
    'объединение дорожек');
  return {output:'lokit-output.mp4',ext:'mp4'};
}
function runSplit(core,inputs,options,vr=false){
  if(inputs.length!==(vr?1:2))throw new Error('Неверное количество видео для разделённого экрана.');
  const {width,height}=geometry(options,true),half=Math.floor(width/4)*2;
  const offset=vr?0:bounded(options.offsetSeconds,0,3600,0);
  const side=i=>'['+i+':v:0]setpts=PTS-STARTPTS,scale='+half+':'+height+
    ':force_original_aspect_ratio=decrease:flags=bicubic,pad='+half+':'+height+
    ':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30'+(i===1&&offset?(',tpad=start_mode=add:start_duration='+offset):'')+
    '[side'+i+']';
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',inputs[0]];
  if(!vr)args.push('-i',inputs[1]);
  const graph=vr
    ?'[0:v:0]split=2[leftSource][rightSource];'+
      '[leftSource]setpts=PTS-STARTPTS,scale='+half+':'+height+
      ':force_original_aspect_ratio=decrease:flags=bicubic,pad='+half+':'+height+
      ':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[side0];'+
      '[rightSource]setpts=PTS-STARTPTS,scale='+half+':'+height+
      ':force_original_aspect_ratio=decrease:flags=bicubic,pad='+half+':'+height+
      ':(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[side1];'
    :side(0)+';'+side(1)+';';
  args.push('-filter_complex',graph+'[side0][side1]hstack=inputs=2:shortest=0[v]',
    '-map','[v]','-map','0:a?','-r','30');
  encoderArgs(args);
  args.push('lokit-output.mp4');
  requireExec(core,args,'создание разделённого экрана');
  return {output:'lokit-output.mp4',ext:'mp4'};
}
function runWatermark(core,inputs,options){
  if(inputs.length!==1)throw new Error('Нужен один исходный ролик.');
  const image=new Uint8Array(options.watermarkPng||[]);
  if(image.length<64||![137,80,78,71,13,10,26,10].every((byte,i)=>image[i]===byte))
    throw new Error('Текстовая подпись PNG не создана.');
  core.FS.writeFile('lokit-watermark.png',image);
  const source=inputs[0];
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',source,
    '-i','lokit-watermark.png'];
  const resolution=options.resolution==='original'||!options.resolution?null:Number(options.resolution);
  const base=Number.isFinite(resolution)&&resolution>=144&&resolution<=2160
    ?'scale=w=if(gte(iw\\,ih)\\,-2\\,min(iw\\,'+resolution+
      ')):h=if(gte(iw\\,ih)\\,min(ih\\,'+resolution+')\\,-2)'
    :'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  // Render text with Canvas rather than FFmpeg drawtext: Cyrillic works even
  // on FFmpeg builds without libfreetype/font files.
  const graph='[0:v:0]'+base+'[base];[1:v:0][base]scale2ref=w=main_w*0.6:h=ow/mdar[mark][reference];'
    +'[reference][mark]overlay=x=W-w-12:y=H-h-12:shortest=1:format=auto[v]';
  args.push('-filter_complex',graph,'-map','[v]','-map','0:a?');
  encoderArgs(args);
  args.push('lokit-output.mp4');
  requireExec(core,args,'наложение текстовой подписи');
  return {output:'lokit-output.mp4',ext:'mp4'};
}

function ffmpegPlan(data){
  const options=data.options||{},mode=data.mode;
  const allowed=new Set(['convert','compress','trim','mute','speed','loop','crop',
    'flip-h','flip-v','rotate-90','rotate-180','rotate-270','filter','blur',
    'volume','extract-audio','frame','merge','split','watermark','vr']);
  if(!allowed.has(mode))throw new Error('Этот инструмент не поддерживает FFmpeg/WASM.');
  const ext=/\.([a-z0-9]{2,5})$/i.exec(data.name||'')?.[1]?.toLowerCase()||'bin';
  const source='input.'+ext;
  const output=mode==='frame'?'lokit-frame.png':mode==='extract-audio'?'lokit-audio.m4a':'lokit-output.mp4';
  const args=['-hide_banner','-loglevel','error','-nostdin','-y'];
  if(mode==='trim')args.push('-ss',String(bounded(options.start,0,86400,0)));
  if(mode==='frame')args.push('-ss',String(bounded(options.seconds,0,86400,0)));

  if(mode==='loop')args.push('-stream_loop',String(Math.round(bounded(options.loops,1,10,2))-1));
  args.push('-i',source);
  if(mode==='trim'){
    const start=bounded(options.start,0,86400,0),end=bounded(options.end,0,86400,0);
    if(end>0){if(end<=start)throw new Error('Конец обрезки должен быть позже начала.');args.push('-t',String(end-start));}
  }
  if(mode==='frame'){
    args.push('-map','0:v:0','-frames:v','1','-update','1',output);
    return {args,source,output,ext:'png'};
  }
  if(mode==='extract-audio'){
    args.push('-map','0:a:0','-vn','-c:a','aac','-b:a','192k',output);
    return {args,source,output,ext:'m4a'};
  }
  args.push('-map','0:v:0');
  if(mode==='mute')args.push('-an');
  else args.push('-map','0:a?');
  const filters=[];
  const effect=filterFor(mode,options);
  if(effect)filters.push(effect);
  const resolution=Number(options.resolution);
  if(Number.isInteger(resolution)&&resolution>=144&&resolution<=2160){
    filters.push("scale=w='if(gte(iw,ih),-2,min(iw,"+resolution+"))':h='if(gte(iw,ih),min(ih,"+resolution+"),-2)':flags=bicubic");
  }
  // The MP4/H.264 encoder requires even dimensions, including odd-sized crops.
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if(filters.length)args.push('-vf',filters.join(','));
  const fps=Number(options.fps);
  if((mode==='convert'||mode==='compress')&&Number.isFinite(fps)&&fps>=5&&fps<=60)
    args.push('-r',String(fps));
  const audioEffect=audioFilterFor(mode,options);
  if(audioEffect&&mode!=='mute')args.push('-af',audioEffect);
  args.push('-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p');
  if(mode==='compress')args.push('-b:v',String(Math.round(bounded(options.bitrate,150000,5000000,650000))));
  else args.push('-crf','24');
  if(mode!=='mute')args.push('-c:a','aac','-b:a','160k');
  args.push('-movflags','+faststart',output);
  return {args,source,output,ext:'mp4'};
}
self.onmessage=async({data})=>{
  if(data?.type!=='run')return;
  try{
    const inputs=(data.inputs?.length?data.inputs:[{name:data.name,bytes:data.bytes}]);
    if(!inputs.length||inputs.length>2||inputs.some(x=>!x.bytes?.byteLength))
      throw new Error('Неверные исходные файлы.');
    const names=inputs.map((input,i)=>'input'+i+'.'+safeExt(input.name));
    // Never interpolate untrusted file names into a shell/FFmpeg argument.
    const multi=['merge','split'].includes(data.mode);
    if(names.length!==(multi?2:1))throw new Error('Неверное количество исходников.');
    const mainScriptUrlOrBlob=data.coreScriptUrl+'#'+btoa(JSON.stringify({wasmURL:data.wasmUrl}));
    importScripts(data.coreScriptUrl);
    if(typeof self.createFFmpegCore!=='function')throw new Error('Не удалось запустить FFmpeg.');
    const core=await self.createFFmpegCore({mainScriptUrlOrBlob});
    core.setProgress?.(({progress})=>{
      if(Number.isFinite(progress))self.postMessage({type:'progress',percent:Math.max(0,Math.min(99,progress*100))});
    });
    inputs.forEach((input,i)=>core.FS.writeFile(names[i],new Uint8Array(input.bytes)));
    let plan;
    if(data.mode==='merge')plan=runMerge(core,names,data.options||{});
    else if(data.mode==='split'||data.mode==='vr')plan=runSplit(core,names,data.options||{},data.mode==='vr');
    else if(data.mode==='watermark')plan=runWatermark(core,names,data.options||{});
    else {
      const single=ffmpegPlan({...data,name:names[0]});
      // Legacy single-source command plans reference input.<ext>.
      // Reuse the actual name written to the virtual filesystem.
      single.args=single.args.map(arg=>arg===single.source?names[0]:arg);
      requireExec(core,single.args,'обработка видео');
      plan={output:single.output,ext:single.ext};
    }
    const result=core.FS.readFile(plan.output);
    if(!result?.byteLength)throw new Error('FFmpeg не создал файл.');
    const owned=result.slice();
    self.postMessage({type:'done',data:owned.buffer,ext:plan.ext},[owned.buffer]);
  }catch(e){self.postMessage({type:'error',message:String(e?.message||e)});}
};