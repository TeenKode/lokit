import './vendor/trim-timeline.js';
import './vendor/subtitle-serializer.js';
import './vendor/waveform-preview.js';
/**
 * Lokit Studio — local, reusable visual editing controls.
 * Handles preview and editable subtitle documents; never uploads user media.
 */
const cap=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const prettyTime=sec=>{const s=Math.max(0,Number(sec)||0);const m=Math.floor(s/60),r=Math.floor(s)%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;};
const el=(tag,className='',text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
function button(label,cls='',title=label){const e=el('button',cls,label);e.type='button';e.title=title;return e;}
function isVideo(f){return Boolean(f&&(f.type.startsWith('video/')||/\.(mp4|mov|m4v|webm|ogv|mkv)$/i.test(f.name)));}
function isSubtitle(f){return Boolean(f&&(/\.(srt|vtt)$/i.test(f.name)||/^text\//.test(f.type)));}
function findValue(form,name){return form.elements.namedItem(name)?.value;}
function setValue(form,name,value){const field=form.elements.namedItem(name);if(!field)return;field.value=String(value);field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
function seekVideo(video,target){if(!video||!Number.isFinite(video.duration))return;video.currentTime=cap(target,0,Math.max(0,video.duration-.01));}

function makeStudioFrame(){
  const shell=el('section','studio-shell');shell.setAttribute('aria-label','Визуальный редактор');
  const top=el('div','studio-heading');const heading=el('div','studio-heading-info');
  heading.append(el('span','studio-eyebrow','РАБОЧАЯ ОБЛАСТЬ'),el('strong','','Предпросмотр и редактирование'));
  const badge=el('span','studio-badge','Локально');top.append(heading,badge);
  const content=el('div','studio-content');shell.append(top,content);return {shell,content,badge};
}

function createCaptureStudio(root,tool){
  const {shell,content}=makeStudioFrame();root.append(shell);
  const placeholder=el('div','studio-placeholder studio-capture');
  const icon=el('div','studio-placeholder-icon',tool.id==='screen-recorder'?'▣':'◎');
  placeholder.append(icon,el('h3','',tool.id==='screen-recorder'?'Запись экрана':'Запись камеры'));
  placeholder.append(el('p','',tool.id==='screen-recorder'?
    'По нажатию «Начать запись» браузер предложит выбрать экран или вкладку.':'Браузер запросит доступ к камере и микрофону после нажатия «Начать запись».'));
  placeholder.append(el('span','studio-hint','Во время записи отображается таймер и кнопка остановки.'));
  content.append(placeholder);
  return {update(){},getFiles:f=>f,destroy(){}};
}

function videoStudio(root,tool,form){
  const {shell,content,badge}=makeStudioFrame();root.append(shell);
  const placeholder=el('div','studio-placeholder');
  placeholder.append(el('div','studio-placeholder-icon','▣'),el('h3','','Файл ещё не выбран'),el('p','','Загрузите видео выше — здесь появятся предпросмотр, кадры и временная шкала.'));
  content.append(placeholder);
  const panel=el('div','studio-video-panel hidden');
  const viewport=el('div','studio-video-viewport');
  const surface=el('div','studio-video-surface');
  const video=el('video','studio-player');video.preload='metadata';video.playsInline=true;video.controls=false;video.setAttribute('aria-label','Предпросмотр исходного видео');
  const second=el('video','studio-player studio-player-secondary hidden');second.preload='metadata';second.playsInline=true;second.muted=true;
  const watermark=el('span','studio-watermark hidden');
  const cropbox=el('div','studio-crop-box hidden');cropbox.append(el('span','studio-crop-handle tl'),el('span','studio-crop-handle tr'),el('span','studio-crop-handle bl'),el('span','studio-crop-handle br'));
  surface.append(video,second,watermark,cropbox);viewport.append(surface);
  const bar=el('div','studio-controls');
  const back=button('−5с','studio-mini-button','Назад на 5 секунд');const play=button('▶','studio-play','Воспроизвести/пауза');const forward=button('+5с','studio-mini-button','Вперёд на 5 секунд');
  const time=el('span','studio-time','00:00 / 00:00');const resolution=el('span','studio-resolution','');
  bar.append(back,play,forward,time,resolution);
  const timeline=el('div','studio-timeline'+(tool.id==='video-trim'?' hidden':''));
  const frames=el('div','studio-frames');
  const seek=el('input','studio-seek');seek.type='range';seek.min='0';seek.max='1000';seek.step='1';seek.value='0';seek.setAttribute('aria-label','Позиция видео');
  const rangeIndicator=el('div','studio-range hidden');
  const track=el('div','studio-track');track.append(rangeIndicator,seek);timeline.append(frames,track);
  const tips=el('div','studio-help');tips.append(el('span','','Пробел — пауза · ← и → — по 5 секунд'),el('span','','Предпросмотр ≠ финальный экспорт'));
  panel.append(viewport,bar,timeline,tips);
  content.append(panel);
  const rangeControls=el('div','studio-trim hidden');
  const sourceTimeline=el('div','studio-source-timeline');
  rangeControls.append(sourceTimeline);
  let trimWidget=null;
  const trimTitle=el('strong','','Выберите отрезок');const trimInputs=el('div','studio-trim-controls');
  const from=el('input');from.type='range';from.min='0';from.max='1000';from.value='0';from.setAttribute('aria-label','Начало отрезка');
  const to=el('input');to.type='range';to.min='0';to.max='1000';to.value='1000';to.setAttribute('aria-label','Конец отрезка');
  const trimReadout=el('span','studio-trim-readout','00:00 — 00:00');
  trimInputs.append(from,to);rangeControls.append(trimTitle,trimInputs,trimReadout);content.append(rangeControls);
  const status=el('div','studio-notice hidden');content.append(status);
  let audioGraph=null;
  if(tool.category==='Аудио'){
    const waveArea=el('div','studio-wave-area');
    const waveButton=button('Показать форму звука','studio-mini-button');
    const waveCanvas=el('canvas','studio-wave-canvas');waveCanvas.height=84;
    const waveStatus=el('span','studio-hint','График строится локально при поддержке декодирования');
    waveArea.append(waveButton,waveCanvas,waveStatus);content.append(waveArea);
    waveButton.addEventListener('click',async()=>{
      if(!objectFile){waveStatus.textContent='Выберите видеофайл';return;}
      if(objectFile.size>16*1024*1024){waveStatus.textContent='Для быстрой визуализации выберите файл меньше 16 МБ';return;}
      waveButton.disabled=true;
      waveStatus.textContent='Анализ звука…';
      const token=generation;
      let ctx=null;
      try{
        ctx=new (window.AudioContext||window.webkitAudioContext)();
        const buffer=await ctx.decodeAudioData(await objectFile.arrayBuffer());
        if(token!==generation||destroyed)return;
        const peaks=window.WaveformPreview?.peaks(buffer,180);
        if(!peaks)throw new Error('Нет данных');
        const width=waveCanvas.clientWidth||620,height=84,dpr=Math.min(window.devicePixelRatio||1,2);
        waveCanvas.width=Math.round(width*dpr);waveCanvas.height=height*dpr;
        const graph=waveCanvas.getContext('2d');graph.scale(dpr,dpr);graph.clearRect(0,0,width,height);
        graph.fillStyle='#6bc4ff';
        for(let i=0;i<peaks.mins.length;i++){
          const x=i*width/peaks.mins.length,lo=peaks.mins[i],hi=peaks.maxs[i];
          graph.fillRect(x,height*(1-hi)/2,Math.max(1,width/peaks.mins.length-1),Math.max(1,(hi-lo)*height/2));
        }
        waveStatus.textContent='Форма звука построена';
      }catch{waveStatus.textContent='Не удалось декодировать аудио этого формата в браузере';}
      finally{await ctx?.close().catch(()=>{});waveButton.disabled=false;}
    });
  }
  let url=null,urlB=null,generation=0,destroyed=false,duration=0,objectFile=null,frameObjectUrl=null;
  const listeners=[];
  const listen=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push([node,type,fn]);};
  const showError=text=>{status.classList.remove('hidden');status.textContent=text;};
  const hideError=()=>{status.classList.add('hidden');status.textContent='';};
  const syncTime=()=>{
    if(!Number.isFinite(video.duration))return;
    const t=video.currentTime;time.textContent=`${prettyTime(t)} / ${prettyTime(video.duration)}`;
    seek.value=String(Math.round(t/video.duration*1000)||0);
    trimWidget?.setPlayhead(t);
    if(tool.id==='video-merge'&&second.src){
      // Второй файл показан отдельно: он не воспроизводится автоматически до стадии экспорта.
    }
  };
  function updateEffect(){
    const mode=tool.id;
    const filter=mode==='video-filter'?findValue(form,'filter'):'none';
    video.style.filter=mode==='video-blur'?`blur(${cap(Number(findValue(form,'blur'))||0,0,35)}px)`:(filter||'none');
    let transforms=[];
    if(mode==='video-flip')transforms.push(findValue(form,'axis')==='vertical'?'scaleY(-1)':'scaleX(-1)');
    if(mode==='video-rotate'){
      const angle=Number(findValue(form,'degrees'))||90;
      transforms.push(`rotate(${angle}deg)`);
      if(angle%180!==0&&video.videoWidth&&video.videoHeight){const factor=Math.min(1,video.videoWidth/video.videoHeight,video.videoHeight/video.videoWidth);transforms.push(`scale(${factor})`);}
    }
    video.style.transform=transforms.join(' ')||'none';
    if(mode==='video-speed')video.playbackRate=cap(Number(findValue(form,'speed'))||1,.25,4);
    if(mode==='video-volume')video.volume=cap(Number(findValue(form,'gain'))||1,0,1);
    watermark.classList.toggle('hidden',mode!=='video-watermark');watermark.textContent=findValue(form,'text')||'Моё видео';
    cropbox.classList.toggle('hidden',mode!=='video-crop');
    if(mode==='video-crop'){const p=cap(Number(findValue(form,'crop'))||0,0,40);cropbox.style.inset=`${p}%`;}else cropbox.style.inset='';
    surface.classList.toggle('studio-split',mode==='split-screen');
  }
  function updateTrim(){
    if(tool.id!=='video-trim'||!duration)return;
    const start=cap(Number(findValue(form,'start'))||0,0,duration);
    const rawEnd=Number(findValue(form,'end'))||duration;
    const end=cap(rawEnd,0,duration);
    if(rawEnd>0&&end<=start){showError('Конец фрагмента должен быть позже начала.');return;}
    hideError();
    from.value=String(Math.round(start/duration*1000));to.value=String(Math.round(end/duration*1000));
    trimReadout.textContent=`${prettyTime(start)} — ${prettyTime(end)}`;
    rangeIndicator.style.left=`${start/duration*100}%`;
    rangeIndicator.style.width=`${Math.max(0,(end-start)/duration*100)}%`;
    if(trimWidget){const current=trimWidget.getRange();if(Math.abs(current.start-start)>.12||Math.abs(current.end-end)>.12)trimWidget.setRange(start,end);}
  }
  function updateTrimmer(elRange,name){if(!duration)return;
    const t=Math.round(Number(elRange.value)/1000*duration*10)/10;
    const other=name==='start'?(Number(findValue(form,'end'))||duration):Number(findValue(form,'start'))||0;
    const safe=name==='start'?Math.min(t,other-.1):Math.max(t,other+.1);
    setValue(form,name,cap(safe,0,duration).toFixed(1));seekVideo(video,safe);
  }
  listen(from,'input',()=>updateTrimmer(from,'start'));
  listen(to,'input',()=>updateTrimmer(to,'end'));
  listen(form,'input',()=>{updateEffect();updateTrim();});listen(form,'change',()=>{updateEffect();updateTrim();});
  listen(video,'loadedmetadata',()=>{
    if(!Number.isFinite(video.duration)||video.duration<=0){showError('Браузер не может прочитать длительность файла.');return;}
    duration=video.duration;
    time.textContent=`00:00 / ${prettyTime(duration)}`;resolution.textContent=`${video.videoWidth} × ${video.videoHeight}`;
    rangeControls.classList.toggle('hidden',tool.id!=='video-trim');
    if(tool.id==='video-trim' && window.createTrimTimeline){
      trimWidget?.destroy();trimWidget=window.createTrimTimeline(sourceTimeline,{
        labels:{start:'Начало',end:'Конец',keep:'Оставить',setHint:'Поставить маркер'},
        onChange:(start,end)=>{
          // The visual handles are the source of the export settings.
          setValue(form,'start',start.toFixed(2));setValue(form,'end',end.toFixed(2));
        },
        onScrub:point=>seekVideo(video,point)
      });
      trimWidget.load(objectFile,duration);
    }
    updateTrim();updateEffect();
  });
  listen(video,'timeupdate',syncTime);
  listen(video,'play',()=>play.textContent='Ⅱ');listen(video,'pause',()=>play.textContent='▶');
  listen(video,'ended',()=>play.textContent='▶');
  listen(play,'click',()=>{if(video.paused)video.play().catch(()=>showError('Не удалось воспроизвести видео.'));else video.pause();});
  listen(back,'click',()=>seekVideo(video,video.currentTime-5));listen(forward,'click',()=>seekVideo(video,video.currentTime+5));
  listen(seek,'input',()=>seekVideo(video,Number(seek.value)/1000*duration));
  listen(viewport,'keydown',e=>{if(e.target instanceof HTMLInputElement)return;
    if([' ','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();if(e.key===' ')play.click();else seekVideo(video,video.currentTime+(e.key==='ArrowRight'?5:-5));}
  });viewport.tabIndex=0;
  function reset(){
    generation++;duration=0;video.pause();second.pause();
    trimWidget?.destroy();trimWidget=null;
    video.removeAttribute('src');second.removeAttribute('src');video.load();second.load();
    if(url)URL.revokeObjectURL(url);if(urlB)URL.revokeObjectURL(urlB);
    url=null;urlB=null;objectFile=null;frames.replaceChildren();seek.value='0';
    resolution.textContent='';time.textContent='00:00 / 00:00';
    rangeControls.classList.add('hidden');hideError();
  }
  async function createFrames(file,token){
    const clone=document.createElement('video');clone.muted=true;clone.preload='auto';clone.playsInline=true;
    const previewUrl=URL.createObjectURL(file);frameObjectUrl=previewUrl;clone.src=previewUrl;
    const cleanup=()=>{clone.pause();clone.removeAttribute('src');clone.load();URL.revokeObjectURL(previewUrl);if(frameObjectUrl===previewUrl)frameObjectUrl=null;};
    try{
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timed out')),5500);
        clone.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});
        clone.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('decode error'));},{once:true});clone.load();});
      for(let i=0;i<6;i++){
        if(token!==generation||destroyed)break;
        const at=duration?cap(duration*(i+.5)/6,0,Math.max(0,duration-.04)):0;
        await new Promise(resolve=>{
          const timeout=setTimeout(done,1900);function done(){clearTimeout(timeout);clone.removeEventListener('seeked',done);resolve();}
          clone.addEventListener('seeked',done,{once:true});try{clone.currentTime=at;}catch{done();}
        });
        if(token!==generation||destroyed)break;
        if(clone.readyState<2)continue;
        const canvas=document.createElement('canvas');canvas.width=140;canvas.height=80;
        const ctx=canvas.getContext('2d');if(!ctx)break;
        try{ctx.drawImage(clone,0,0,140,80);}catch{continue;}
        const thumb=el('button','studio-frame');thumb.type='button';thumb.title=prettyTime(at);
        thumb.append(canvas);thumb.addEventListener('click',()=>seekVideo(video,at));frames.append(thumb);
      }
    }catch{ /* Фильм может не поддерживать seek в браузере. */ }
    finally{cleanup();}
  }
  function update(files){
    reset();
    const first=files?.[0];if(!isVideo(first)){
      placeholder.classList.remove('hidden');panel.classList.add('hidden');badge.textContent='Ожидание файла';return;
    }
    objectFile=first;
    placeholder.classList.add('hidden');panel.classList.remove('hidden');badge.textContent='Реальное время';
    url=URL.createObjectURL(first);video.src=url;video.load();
    if(files?.[1]&&isVideo(files[1])){urlB=URL.createObjectURL(files[1]);second.src=urlB;second.classList.toggle('hidden',tool.id!=='split-screen');second.load();}
    else second.classList.add('hidden');
    const token=generation;
    void createFrames(first,token);
  }
  function destroy(){destroyed=true;reset();for(const [node,type,handler] of listeners)node.removeEventListener(type,handler);shell.remove();}
  return {update,getFiles:f=>f,destroy};
}

function timeFromText(value){
  const v=String(value).trim().replace(',','.');
  const match=v.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if(!match)return NaN;
  const h=Number(match[1]||0),m=Number(match[2]),s=Number(match[3]);
  if(m>59||s>59)return NaN;
  return h*3600+m*60+s+Number((match[4]||'0').padEnd(3,'0'))/1000;
}
function timeToText(sec,sep=','){
  const ms=Math.max(0,Math.round(Number(sec)*1000)||0);
  const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${sep}${String(ms%1000).padStart(3,'0')}`;
}
export function decodeSubtitle(source){
  const vtt=/^\uFEFF?WEBVTT\b/i.test(source.trimStart());
  const cues=[];const normalized=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  for(const block of normalized.split(/\n\s*\n/)){
    const lines=block.split('\n');const pos=lines.findIndex(line=>line.includes('-->'));if(pos<0)continue;
    const match=lines[pos].match(/((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/);
    if(!match)continue;
    const start=timeFromText(match[1]),end=timeFromText(match[2]);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
    cues.push({start,end,text:lines.slice(pos+1).join('\n')});
  }
  return {type:vtt?'vtt':'srt',cues};
}
export function encodeSubtitle(cues,type='srt'){
  const isVtt=type==='vtt';const blocks=[];
  for(const [i,cue] of cues.entries()){
    const start=timeToText(cue.start,isVtt?'.':','),end=timeToText(cue.end,isVtt?'.':',');
    blocks.push(`${i+1}\n${start} --> ${end}\n${cue.text}`);
  }
  return (isVtt?'WEBVTT\n\n':'')+blocks.join('\n\n')+'\n';
}
function subtitleStudio(root,tool){
  const {shell,content,badge}=makeStudioFrame();root.append(shell);
  const placeholder=el('div','studio-placeholder');placeholder.append(el('div','studio-placeholder-icon','≡'),el('h3','','Загрузите файл субтитров'),el('p','','После загрузки можно редактировать текст и таймкоды прямо здесь. Изменения используются при обработке.'));
  content.append(placeholder);
  const panel=el('div','studio-subtitles hidden');
  const controls=el('div','studio-sub-controls');
  const info=el('span','studio-hint','Изменения сохраняются только в текущей вкладке');
  const fileTabs=el('div','studio-file-tabs');
  const add=button('+ Реплика','secondary');controls.append(info,add);
  const preview=el('div','studio-sub-preview');const previewText=el('div','studio-sub-preview-text','Выберите реплику, чтобы увидеть её здесь.');preview.append(previewText);
  const list=el('div','studio-cue-list');panel.append(fileTabs,preview,controls,list);content.append(panel);
  const status=el('div','studio-notice hidden');content.append(status);
  let tracks=[],active=0,revision=0,destroyed=false,loading=Promise.resolve();
  function buildRows(){
    const track=tracks[active];list.replaceChildren();if(!track)return;
    badge.textContent=`${track.cues.length} реплик`;
    for(const [i,cue] of track.cues.entries()){
      const row=el('div','studio-cue');
      const number=el('span','studio-cue-number',String(i+1));
      const timing=el('div','studio-cue-timing');
      const start=el('input');start.type='text';start.value=timeToText(cue.start);start.setAttribute('aria-label',`Начало реплики ${i+1}`);
      const arrow=el('span','','→');const end=el('input');end.type='text';end.value=timeToText(cue.end);end.setAttribute('aria-label',`Конец реплики ${i+1}`);
      timing.append(start,arrow,end);
      const text=el('textarea');text.rows=2;text.value=cue.text;text.setAttribute('aria-label',`Текст реплики ${i+1}`);
      const remove=button('×','studio-mini-button',`Удалить реплику ${i+1}`);remove.setAttribute('aria-label',`Удалить реплику ${i+1}`);
      const update=()=>{const a=timeFromText(start.value),b=timeFromText(end.value);if(Number.isFinite(a)&&Number.isFinite(b)&&b>a){cue.start=a;cue.end=b;cue.invalid=false;start.classList.remove('invalid');end.classList.remove('invalid');}else{cue.invalid=true;start.classList.add('invalid');end.classList.add('invalid');}
        cue.text=text.value;previewText.textContent=cue.text||'Пустая реплика';revision++;root.dispatchEvent(new Event('lokit-editor-change',{bubbles:true}));};
      start.addEventListener('change',update);end.addEventListener('change',update);text.addEventListener('input',update);
      row.addEventListener('focusin',()=>{previewText.textContent=cue.text||'Пустая реплика';});
      remove.addEventListener('click',()=>{track.cues.splice(i,1);revision++;buildRows();root.dispatchEvent(new Event('lokit-editor-change',{bubbles:true}));});
      row.append(number,timing,text,remove);list.append(row);
    }
  }
  function buildTabs(){fileTabs.replaceChildren();tracks.forEach((t,i)=>{const b=button(t.file.name,'studio-file-tab'+(i===active?' active':''));b.setAttribute('aria-pressed',String(i===active));b.addEventListener('click',()=>{active=i;buildTabs();buildRows();});fileTabs.append(b);});}
  add.addEventListener('click',()=>{const track=tracks[active];if(!track)return;
    const last=track.cues.at(-1)?.end||0;track.cues.push({start:last,end:last+2,text:'Новая реплика'});revision++;buildRows();root.dispatchEvent(new Event('lokit-editor-change',{bubbles:true}));list.lastElementChild?.querySelector('textarea')?.focus();
  });
  async function loadFiles(files){
    const marker=++revision;tracks=[];active=0;status.classList.add('hidden');list.replaceChildren();
    if(!files?.length||!isSubtitle(files[0])){placeholder.classList.remove('hidden');panel.classList.add('hidden');badge.textContent='Ожидание файла';return;}
    for(const file of files.slice(0,2)){
      if(!isSubtitle(file))continue;
      try{
        const parsed=decodeSubtitle(await file.text());if(destroyed||marker!==revision)return;
        if(parsed.cues.length)tracks.push({...parsed,file});
      }catch{ /* Показать понятное сообщение вместо падения */ }
    }
    if(destroyed||marker!==revision)return;
    if(!tracks.length){status.textContent='Не найдены временные метки SRT/VTT. Исходный файл можно обработать, но визуальное редактирование недоступно.';status.classList.remove('hidden');badge.textContent='Нет реплик';return;}
    placeholder.classList.add('hidden');panel.classList.remove('hidden');buildTabs();buildRows();
  }
  function update(files){loading=loadFiles(files);return loading;}
  async function getFiles(files){
    await loading;
    if(destroyed)throw new Error('Редактор закрыт');
    if(!tracks.length)return files;
    const found=new Map(tracks.map(track=>[track.file,track]));
    return files.map(file=>{
      const track=found.get(file);if(!track)return file;
      if(track.cues.some(c=>c.invalid||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.end<=c.start))throw new Error('Исправьте временные метки реплик.');
      const source=window.SubtitleSerializer?.[track.type==='vtt'?'toVtt':'toSrt'](track.cues)||encodeSubtitle(track.cues,track.type);
      return new File([source],file.name,{type:'text/plain;charset=utf-8',lastModified:Date.now()});
    });
  }
  function destroy(){destroyed=true;revision++;shell.remove();}
  return {update,getFiles,destroy};
}

export function mountEditor({host,tool,form}){
  if(tool.isCapture)return createCaptureStudio(host,tool);
  if(tool.category==='Субтитры')return subtitleStudio(host,tool);
  return videoStudio(host,tool,form);
}
