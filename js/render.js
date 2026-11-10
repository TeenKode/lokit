// Единственный Canvas-рендерер для экспорта и предпросмотра Lokit.
const clamp=(x,min,max)=>Math.min(max,Math.max(min,x));
const even=n=>Math.max(2,Math.round(n/2)*2);
function renderFit(ctx, video, x, y, width, height) {
  if (!video || video.readyState < 2) return;
  const scale = Math.min(width/video.videoWidth,height/video.videoHeight);
  const w=video.videoWidth*scale,h=video.videoHeight*scale;
  ctx.drawImage(video,x+(width-w)/2,y+(height-h)/2,w,h);
}
export function renderVideoFrame(ctx, a, b, mode, options, outWidth, outHeight) {
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
/**
 * Resolutions use the SHORTER source side: 720p landscape = 1280×720,
 * 720p portrait = 720×1280. Never upscale and keep aspect ratio.
 * "original" preserves input dimensions (except multi-video composites).
 */
export function canvasSize(info, mode, options={}) {
  let w=Number(info.width),h=Number(info.height);
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)throw new Error('Не удалось определить размер исходного видео.');
  if(mode==='crop'){
    const p=clamp(Number(options.crop)||0,0,40)/100;
    w*=1-2*p;h*=1-2*p;
  }
  if(['rotate-90','rotate-270'].includes(mode)) [w,h]=[h,w];
  if(mode==='split'||mode==='vr'){
    // Two frames side by side form a new landscape canvas, not the source size.
    const side=Math.min(w,h);
    w=side*16/9;h=side;
  }
  const resolution=String(options.resolution ?? options.width ?? 'original');
  const target=resolution==='original'?null:Number(resolution);
  if(target!==null&&(!Number.isFinite(target)||target<240||target>2160))throw new Error('Выберите допустимое разрешение: исходное, 360p, 480p, 720p, 1080p или 2160p.');
  const scale=target===null?1:Math.min(1,target/Math.min(w,h));
  return {width:even(w*scale),height:even(h*scale)};
}

// Режим исходного инструмента и экспорт должны использовать одну трансформацию.
export function previewModeFor(toolId,values={}){
  if(toolId==='video-flip')return values.axis==='vertical'?'flip-v':'flip-h';
  if(toolId==='video-rotate')return ['90','180','270'].includes(String(values.degrees))?`rotate-${values.degrees}`:'rotate-90';
  const modes={
    'video-trim':'trim','mute-video':'mute','video-crop':'crop','video-speed':'speed',
    'video-loop':'loop','video-filter':'filter','video-blur':'blur','video-watermark':'watermark',
    'video-converter':'convert','video-compressor':'compress','video-volume':'volume',
    'video-merge':'merge','split-screen':'split','video-to-vr':'vr'
  };
  return modes[toolId]||'convert';
}
