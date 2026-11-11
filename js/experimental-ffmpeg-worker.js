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
function ffmpegPlan(data){
  const options=data.options||{},mode=data.mode;
  const allowed=new Set(['convert','compress','trim','mute','speed','loop','crop',
    'flip-h','flip-v','rotate-90','rotate-180','rotate-270','filter','blur',
    'volume','extract-audio','frame']);
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
    const plan=ffmpegPlan(data);
    importScripts(data.coreScriptUrl);
    if(typeof self.createFFmpegCore!=='function')throw new Error('FFmpeg core не инициализирован.');
    const mainScriptUrlOrBlob=`${data.coreScriptUrl}#${btoa(JSON.stringify({wasmURL:data.wasmUrl}))}`;
    const core=await self.createFFmpegCore({mainScriptUrlOrBlob});
    core.setProgress?.(({progress})=>{
      if(Number.isFinite(progress))self.postMessage({type:'progress',percent:Math.max(0,Math.min(99,progress*100))});
    });
    core.FS.writeFile(plan.source,new Uint8Array(data.bytes));
    const exitCode=core.exec(...plan.args);
    if((typeof exitCode==='number'&&exitCode!==0)||core.ret!==0)
      throw new Error('FFmpeg завершился с ошибкой ('+(core.ret??exitCode)+').');
    const result=core.FS.readFile(plan.output);
    if(!result?.byteLength)throw new Error('FFmpeg вернул пустой файл.');
    const owned=result.slice();
    self.postMessage({type:'done',data:owned.buffer,ext:plan.ext},[owned.buffer]);
  }catch(e){self.postMessage({type:'error',message:String(e?.message||e)});}
};