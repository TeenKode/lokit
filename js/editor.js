import './vendor/trim-timeline.js';
import './vendor/subtitle-serializer.js';
import './vendor/waveform-preview.js';
import {renderVideoFrame,canvasSize,previewModeFor} from './render.js';
import {createEditHistory} from './edit-history.js';
import {mountPrecisionTimeline,stepFrame} from './precision-timeline.js';
import {multiTrackLayout,locateMergeTime,splitSourceTime,mountMultiTrack} from './multitrack.js';
import {mountSubtitleTimeline} from './subtitle-timeline.js';
/**
 * Lokit Studio — local, reusable visual editing controls.
 * Handles preview and editable subtitle documents; never uploads user media.
 */
const cap=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
const prettyTime=sec=>{const s=Math.max(0,Number(sec)||0);const m=Math.floor(s/60),r=Math.floor(s)%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;};
const el=(tag,className='',text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
function button(label,cls='',title=label){const e=el('button',cls,label);e.type='button';e.title=title;return e;}
function isVideo(f){return Boolean(f&&(f.type.startsWith('video/')||/\.(mp4|m4v|mov|3gp|3g2|webm|mkv|avi|wmv|flv|mpeg|mpg|ts|mts|m2ts|ogv)$/i.test(f.name)));}
function isSubtitle(f){return Boolean(f&&(/\.(srt|vtt)$/i.test(f.name)||/^text\//.test(f.type)));}
function findValue(form,name){return form.elements.namedItem(name)?.value;}
function setValue(form,name,value){const field=form.elements.namedItem(name);if(!field)return;field.value=String(value);field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
function seekVideo(video,target){if(!video||!Number.isFinite(video.duration))return;video.currentTime=cap(target,0,Math.max(0,video.duration-.01));}

function makeStudioFrame(){
  const shell=el('section','studio-shell');shell.setAttribute('aria-label','Визуальный редактор');
  const top=el('div','studio-heading');const heading=el('div','studio-heading-info');
  heading.append(el('span','studio-eyebrow','РЕДАКТОР'),el('strong','','Предпросмотр'));
  const badge=el('span','studio-badge','Локально');top.append(heading,badge);
  const content=el('div','studio-content');shell.append(top,content);return {shell,content,badge};
}

function createCaptureStudio(root,tool){
  const {shell,content,badge}=makeStudioFrame();root.append(shell);
  const placeholder=el('div','studio-placeholder studio-capture');
  const icon=el('div','studio-placeholder-icon',tool.id==='screen-recorder'?'▣':'◎');
  placeholder.append(icon,el('h3','',tool.id==='screen-recorder'?'Запись экрана':'Запись камеры'));
  placeholder.append(el('p','',tool.id==='screen-recorder'?
    'После нажатия «Начать запись» выберите экран, окно или вкладку.':'После нажатия «Начать запись» разрешите доступ к камере и микрофону.'));
  placeholder.append(el('span','studio-hint','Во время записи вы увидите таймер и кнопку остановки.'));
  const live=el('div','studio-capture-live hidden');
  const feed=el('video');feed.muted=true;feed.playsInline=true;feed.autoplay=true;feed.setAttribute('aria-label','Предпросмотр записи');
  const meterLabel=el('label','studio-hint','Уровень микрофона');
  const meter=el('progress','studio-audio-meter');meter.max=100;meter.value=0;meter.setAttribute('aria-label','Уровень звука микрофона');
  meterLabel.append(meter);live.append(feed,meterLabel);content.append(placeholder,live);
  let context=null,raf=null,destroyed=false;
  const stopMeter=()=>{if(raf!==null)cancelAnimationFrame(raf);raf=null;void context?.close().catch(()=>{});context=null;meter.value=0;};
  function setStream(stream){
    stopMeter();feed.pause();feed.srcObject=null;
    if(!stream||destroyed){live.classList.add('hidden');placeholder.classList.remove('hidden');badge.textContent='Локально';return;}
    live.classList.remove('hidden');placeholder.classList.add('hidden');badge.textContent='Запись';
    feed.srcObject=stream;void feed.play().catch(()=>{});
    if(!stream.getAudioTracks().length){meterLabel.classList.add('hidden');return;}
    meterLabel.classList.remove('hidden');
    try{
      context=new (window.AudioContext||window.webkitAudioContext)();
      const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=1024;
      source.connect(analyser);const data=new Uint8Array(analyser.fftSize);
      const tick=()=>{
        if(!context||destroyed)return;
        analyser.getByteTimeDomainData(data);
        let power=0;for(const v of data)power+=(v-128)**2;
        meter.value=Math.min(100,Math.round(Math.sqrt(power/data.length)/64*100));
        raf=requestAnimationFrame(tick);
      };tick();
    }catch{meterLabel.classList.add('hidden');stopMeter();}
  }
  return {update(){},getFiles:f=>f,setStream,destroy(){destroyed=true;setStream(null);shell.remove();}};
}

function videoStudio(root,tool,form){
  const {shell,content,badge}=makeStudioFrame();root.append(shell);
  const placeholder=el('div','studio-placeholder');
  placeholder.append(el('div','studio-placeholder-icon','▣'),el('h3','','Видео пока не выбрано'),el('p','','Выберите видео выше, чтобы открыть просмотр и временную шкалу.'));
  content.append(placeholder);
  const panel=el('div','studio-video-panel hidden');
  const viewport=el('div','studio-video-viewport');
  const surface=el('div','studio-video-surface');
  const video=el('video','studio-player');video.preload='metadata';video.playsInline=true;video.controls=false;video.setAttribute('aria-label','Исходное видео');
  const second=el('video','studio-player studio-player-secondary hidden');second.preload='metadata';second.playsInline=true;second.muted=true;
  const watermark=el('span','studio-watermark hidden');
  const cropbox=el('div','studio-crop-box hidden');cropbox.append(el('span','studio-crop-handle tl'),el('span','studio-crop-handle tr'),el('span','studio-crop-handle bl'),el('span','studio-crop-handle br'));
  const renderedCanvas=el('canvas','studio-rendered-canvas');renderedCanvas.setAttribute('aria-label','Предпросмотр результата');
  surface.append(video,second,renderedCanvas,watermark,cropbox);viewport.append(surface);
  const bar=el('div','studio-controls');
  const back=button('−5с','studio-mini-button','Назад на 5 секунд');const play=button('▶','studio-play','Воспроизвести или приостановить');const forward=button('+5с','studio-mini-button','Вперёд на 5 секунд');
  const time=el('span','studio-time','00:00 / 00:00');const resolution=el('span','studio-resolution','');
  const toggleResult=button('Показать исходник','studio-mini-button','Переключить просмотр исходника и результата');
  toggleResult.setAttribute('aria-pressed','true');
  bar.append(back,play,forward,time,resolution,toggleResult);
  const timeline=el('div','studio-timeline'+(tool.id==='video-trim'?' hidden':''));
  const frames=el('div','studio-frames');
  const seek=el('input','studio-seek');seek.type='range';seek.min='0';seek.max='1000';seek.step='1';seek.value='0';seek.setAttribute('aria-label','Позиция видео');
  const rangeIndicator=el('div','studio-range hidden');
  const track=el('div','studio-track');track.append(rangeIndicator,seek);timeline.append(frames,track);
  const tips=el('div','studio-help');tips.append(el('span','','Пробел — воспроизведение/пауза · J/K/L — управление · [ и ] — границы · Ctrl+Z — отмена'),el('span','','Предпросмотр показывает ожидаемый результат. Поддержка экспорта зависит от браузера.'));
  const multiHost=el('div','studio-multitrack-host');
  panel.append(viewport,bar,timeline,multiHost,tips);
  content.append(panel);
  const rangeControls=el('div','studio-trim hidden');
  const sourceTimeline=el('div','studio-source-timeline');
  rangeControls.append(sourceTimeline);
  const preciseHost=el('div','studio-precise-host');rangeControls.append(preciseHost);
  const historyBar=el('div','studio-history-toolbar');
  const undoTrim=button('↶ Отменить','studio-mini-button','Отменить изменение границ (Ctrl+Z)');undoTrim.dataset.action='trim-undo';
  const redoTrim=button('↷ Повторить','studio-mini-button','Повторить изменение границ (Ctrl+Shift+Z)');redoTrim.dataset.action='trim-redo';
  historyBar.append(undoTrim,redoTrim);rangeControls.append(historyBar);
  let precisionLane=null,trimWidget=null,knownKeyframes=[],syncGuard=false;
  const trimHistory=createEditHistory({start:0,end:0});
  const trimState=()=>({start:Number(findValue(form,'start'))||0,end:Number(findValue(form,'end'))||duration});
  const updateHistoryButtons=()=>{undoTrim.disabled=!trimHistory.canUndo;redoTrim.disabled=!trimHistory.canRedo;};
  function recordTrim(mergeKey=''){
    const state=trimState();
    if(!syncGuard&&duration>0&&state.start>=0&&state.end<=duration+.001&&state.end>state.start){
      trimHistory.record(state,{mergeKey});updateHistoryButtons();
    }
  }
  function applyTrimRange(start,end,{mergeKey='',seek=true,record=true}={}){
    if(!duration||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+.001||end<=start)return false;
    syncGuard=true;
    const startField=form.elements.namedItem('start'),endField=form.elements.namedItem('end');
    if(!startField||!endField){syncGuard=false;return false;}
    startField.value=start.toFixed(3);endField.value=end.toFixed(3);
    startField.dispatchEvent(new Event('change',{bubbles:true}));
    endField.dispatchEvent(new Event('change',{bubbles:true}));
    syncGuard=false;
    updateTrim();
    if(seek)seekVideo(video,start);
    if(record)recordTrim(mergeKey);
    return true;
  }
  const restoreTrim=(action)=>{const state=trimHistory[action]();if(state)applyTrimRange(state.start,state.end,{record:false});updateHistoryButtons();};
  undoTrim.addEventListener('click',()=>restoreTrim('undo'));redoTrim.addEventListener('click',()=>restoreTrim('redo'));
  updateHistoryButtons();
  const trimTitle=el('strong','','Выберите отрезок');const trimInputs=el('div','studio-trim-controls');
  const from=el('input');from.type='range';from.min='0';from.max='1000';from.value='0';from.setAttribute('aria-label','Начало отрезка');
  const to=el('input');to.type='range';to.min='0';to.max='1000';to.value='1000';to.setAttribute('aria-label','Конец отрезка');
  const trimReadout=el('span','studio-trim-readout','00:00 — 00:00');
  trimInputs.append(from,to);rangeControls.append(trimTitle,trimInputs,trimReadout);content.append(rangeControls);
  const status=el('div','studio-notice hidden');content.append(status);
  let audioGraph=null;
  function stopAudioGraph(){
    if(!audioGraph)return;
    if(audioGraph.frame!==null)cancelAnimationFrame(audioGraph.frame);
    void audioGraph.context?.close().catch(()=>{});audioGraph=null;
  }
  if(tool.category==='Аудио'){
    const waveArea=el('div','studio-wave-area');
    const waveButton=button('Показать форму звука','studio-mini-button');
    const waveCanvas=el('canvas','studio-wave-canvas');waveCanvas.height=84;
    const waveStatus=el('span','studio-hint','Звуковая дорожка появится, если браузер сможет её прочитать');
    waveArea.append(waveButton,waveCanvas,waveStatus);content.append(waveArea);
    waveButton.addEventListener('click',async()=>{
      if(!objectFile){waveStatus.textContent='Сначала выберите видео';return;}
      stopAudioGraph();waveButton.disabled=true;
      waveStatus.textContent='Чтение звуковой дорожки…';
      const token=generation;let ctx=null;
      try{
        ctx=new (window.AudioContext||window.webkitAudioContext)();
        const width=waveCanvas.clientWidth||620,height=84,dpr=Math.min(window.devicePixelRatio||1,2);
        waveCanvas.width=Math.round(width*dpr);waveCanvas.height=height*dpr;
        const graph=waveCanvas.getContext('2d');if(!graph)throw new Error('Canvas unavailable');
        graph.scale(dpr,dpr);
        // decodeAudioData() typically cannot decode an MP4 *video* container.
        // For that case use a live Web Audio analyser without loading the full file.
        let peaks=null;
        if(objectFile.size<16*1024*1024){
          try{const buffer=await ctx.decodeAudioData(await objectFile.arrayBuffer());peaks=window.WaveformPreview?.peaks(buffer,180);}catch{}
        }
        if(token!==generation||destroyed)return;
        if(peaks){
          graph.clearRect(0,0,width,height);graph.fillStyle='#6bc4ff';
          for(let i=0;i<peaks.mins.length;i++){
            const x=i*width/peaks.mins.length,lo=peaks.mins[i],hi=peaks.maxs[i];
            graph.fillRect(x,height*(1-hi)/2,Math.max(1,width/peaks.mins.length-1),Math.max(1,(hi-lo)*height/2));
          }
          waveStatus.textContent='Звуковая дорожка готова';
          await ctx.close();ctx=null;
        }else{
          const source=ctx.createMediaElementSource(video),analyser=ctx.createAnalyser();analyser.fftSize=1024;
          source.connect(analyser);analyser.connect(ctx.destination);await ctx.resume();
          if(token!==generation||destroyed)return;
          const data=new Uint8Array(analyser.fftSize);const state={context:ctx,frame:null};audioGraph=state;ctx=null;
          const paint=()=>{
            if(destroyed||generation!==token||audioGraph!==state)return;
            analyser.getByteTimeDomainData(data);graph.clearRect(0,0,width,height);
            graph.strokeStyle='#79ceff';graph.lineWidth=2;graph.beginPath();
            for(let i=0;i<data.length;i++){
              const x=i/data.length*width,y=data[i]/255*height;
              if(i===0)graph.moveTo(x,y);else graph.lineTo(x,y);
            }
            graph.stroke();state.frame=requestAnimationFrame(paint);
          };
          paint();waveStatus.textContent='Звуковая дорожка готова. Нажмите ▶ для прослушивания.';
        }
      }catch{waveStatus.textContent='Браузер не может прочитать звуковую дорожку этого файла.';}
      finally{await ctx?.close().catch(()=>{});waveButton.disabled=false;}
    });
  }
  let url=null,urlB=null,generation=0,destroyed=false,duration=0,objectFile=null,frameObjectUrl=null;
  const multiKind={'video-merge':'merge','split-screen':'split','video-loop':'loop','video-speed':'speed'}[tool.id];
  if(multiKind==='merge'||multiKind==='split')toggleResult.classList.add('hidden');
  let multiView=null,multiLayout=null,projectTime=0,projectPlaying=false,projectRaf=null,projectStartedAt=0;
  const clipDurations=()=>[Number(video.duration)||0,Number(second.duration)||0];
  const getMultiLayout=()=>multiTrackLayout(multiKind,clipDurations(),{
    order:findValue(form,'clipOrder'),offset:findValue(form,'offsetSeconds'),
    loops:findValue(form,'loops'),speed:findValue(form,'speed')
  });
  const projectDuration=()=>multiLayout?.total||duration;
  function updateMulti(){
    if(!multiKind||!duration)return;
    multiLayout=getMultiLayout();
    if(!multiView)multiView=mountMultiTrack(multiHost,{kind:multiKind,onSeek:t=>seekProject(t)});
    multiView.render(multiLayout,[objectFile?.name||'Первый ролик',secondFile?.name||'Второй ролик']);
    projectTime=cap(projectTime,0,projectDuration());
    multiView.setPlayhead(projectTime);
  }
  let secondFile=null;
  const sourceAt=t=>multiKind==='merge'&&multiLayout?locateMergeTime(multiLayout,t):{source:0,time:t};
  function pauseProject(){
    projectPlaying=false;if(projectRaf!==null)cancelAnimationFrame(projectRaf);projectRaf=null;
    video.pause();second.pause();play.textContent='▶';
  }
  function seekProject(t){
    if(!multiKind){seekVideo(video,t);return;}
    projectTime=cap(t,0,projectDuration());
    if(projectPlaying)projectStartedAt=performance.now()-projectTime*1000;
    if(multiKind==='merge'){
      const item=sourceAt(projectTime);
      seekVideo(item.source===0?video:second,item.time);
    }else if(multiKind==='split'){
      seekVideo(video,projectTime);
      seekVideo(second,splitSourceTime(projectTime,findValue(form,'offsetSeconds'),Number(second.duration)||0));
    }else if(multiKind==='loop')seekVideo(video,duration?projectTime%duration:0);
    else if(multiKind==='speed')seekVideo(video,projectTime*cap(Number(findValue(form,'speed'))||1,.25,4));
    syncTime();paintPreview();
  }
  function runProject(){
    if(!projectPlaying||destroyed)return;
    projectTime=Math.min(projectDuration(),(performance.now()-projectStartedAt)/1000);
    const map=sourceAt(projectTime);
    const desired=[];
    if(multiKind==='merge')desired.push({player:map.source===0?video:second,time:map.time});
    else if(multiKind==='split'){
      if(projectTime<duration)desired.push({player:video,time:projectTime});
      const offset=cap(Number(findValue(form,'offsetSeconds'))||0,0,3600);
      if(projectTime>=offset&&projectTime<offset+(Number(second.duration)||0))desired.push({player:second,time:projectTime-offset});
    }else if(multiKind==='loop')desired.push({player:video,time:duration?projectTime%duration:0});
    else desired.push({player:video,time:projectTime*cap(Number(findValue(form,'speed'))||1,.25,4)});
    for(const player of [video,second]){
      const item=desired.find(x=>x.player===player);
      if(!item){if(!player.paused)player.pause();continue;}
      if(Math.abs(player.currentTime-item.time)>.22)seekVideo(player,item.time);
      if(player.paused&&!player.ended)void player.play().catch(()=>pauseProject());
    }
    syncTime();paintPreview();
    if(projectTime>=projectDuration()-.005){pauseProject();return;}
    projectRaf=requestAnimationFrame(runProject);
  }
  function toggleProject(){
    if(projectPlaying){pauseProject();return;}
    if(projectTime>=projectDuration()-.01)seekProject(0);
    projectPlaying=true;projectStartedAt=performance.now()-projectTime*1000;
    play.textContent='Ⅱ';runProject();
  }

  let canvasActive=true,previewFrameRequest=null,previewFrameIsVideo=false,lastPaint=0;
  function getValues(){return Object.fromEntries((tool.options||[]).map(option=>[option.key,findValue(form,option.key)]));}
  function previewSize(){
    if(!video.videoWidth||!video.videoHeight)return null;
    const values=getValues(),mode=previewModeFor(tool.id,values);
    const source=multiKind==='merge'&&values.clipOrder==='reverse'&&second.videoWidth?second:video;
    const size=canvasSize({width:source.videoWidth,height:source.videoHeight},mode,values);
    const reduction=Math.min(1,900/Math.max(size.width,size.height));
    return {width:Math.max(2,Math.round(size.width*reduction/2)*2),height:Math.max(2,Math.round(size.height*reduction/2)*2),mode,values,exportSize:size};
  }
  function paintPreview(){
    if(!canvasActive||destroyed||!objectFile||video.readyState<2)return;
    const size=previewSize();if(!size)return;
    try{
      if(renderedCanvas.width!==size.width)renderedCanvas.width=size.width;
      if(renderedCanvas.height!==size.height)renderedCanvas.height=size.height;
      const ctx=renderedCanvas.getContext('2d',{alpha:false});if(!ctx)return;
      const main=multiKind==='merge'&&sourceAt(projectTime).source===1?second:video;
      const offset=cap(Number(findValue(form,'offsetSeconds'))||0,0,3600);
      const other=multiKind==='split'&&projectTime>=offset&&second.readyState>=2?second:null;
      renderVideoFrame(ctx,main.readyState>=2?main:video,other,size.mode,size.values,size.width,size.height);
      resolution.textContent=`Результат: ${size.exportSize.width} × ${size.exportSize.height}`;
    }catch(error){console.warn('Предпросмотр Canvas недоступен:',error);canvasActive=false;showCanvasMode();}
  }
  function showCanvasMode(){
    surface.classList.toggle('studio-show-render',canvasActive);
    toggleResult.textContent=canvasActive?'Показать исходник':'Показать результат';
    toggleResult.setAttribute('aria-pressed',String(canvasActive));
    if(canvasActive)paintPreview();
  }
  function stopPreviewLoop(){
    if(previewFrameRequest!==null){
      if(previewFrameIsVideo&&typeof video.cancelVideoFrameCallback==='function')video.cancelVideoFrameCallback(previewFrameRequest);
      else cancelAnimationFrame(previewFrameRequest);
    }
    previewFrameRequest=null;
  }
  function loopPreview(){
    stopPreviewLoop();
    if(!canvasActive||video.paused||destroyed||multiKind)return;
    if(typeof video.requestVideoFrameCallback==='function'){
      previewFrameIsVideo=true;
      previewFrameRequest=video.requestVideoFrameCallback(()=>{previewFrameRequest=null;paintPreview();loopPreview();});
    }else{
      previewFrameIsVideo=false;
      previewFrameRequest=requestAnimationFrame(time=>{
        previewFrameRequest=null;
        if(time-lastPaint>=95){paintPreview();lastPaint=time;}
        loopPreview();
      });
    }
  }
  toggleResult.addEventListener('click',()=>{canvasActive=!canvasActive;showCanvasMode();loopPreview();});
  const listeners=[];
  const listen=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push([node,type,fn]);};
  const showError=text=>{status.classList.remove('hidden');status.textContent=text;};
  const hideError=()=>{status.classList.add('hidden');status.textContent='';};
  let syncingFrame=false;
  const syncTime=()=>{
    if(!Number.isFinite(video.duration))return;
    const t=multiKind?projectTime:video.currentTime;
    const total=projectDuration();
    time.textContent=`${prettyTime(t)} / ${prettyTime(total)}`;
    seek.value=String(Math.round(t/(total||1)*1000)||0);
    trimWidget?.setPlayhead(t);precisionLane?.setPlayhead(t);multiView?.setPlayhead(t);
    if(tool.id==='video-frames'&&!syncingFrame){
      const field=form.elements.namedItem('seconds');
      if(field&&Math.abs(Number(field.value)-t)>.035){syncingFrame=true;setValue(form,'seconds',t.toFixed(3));syncingFrame=false;}
    }
  };
  function updateEffect(){
    const mode=tool.id;
    video.style.filter='none';video.style.transform='none';
    if(mode==='video-speed')video.playbackRate=cap(Number(findValue(form,'speed'))||1,.25,4);
    video.muted=mode==='mute-video';
    if(mode==='video-volume')video.volume=cap(Number(findValue(form,'gain'))||1,0,1);
    watermark.classList.add('hidden');cropbox.classList.add('hidden');
    if(mode==='video-crop'){
      const inset=cap(Number(findValue(form,'crop'))||0,0,40);
      cropbox.classList.add('crop-active');cropbox.style.inset=`${inset}%`;
    }else cropbox.classList.remove('crop-active');
    if(multiKind)updateMulti();
    surface.classList.toggle('studio-split',mode==='split-screen');
    paintPreview();
  }
  // Symmetric crop handles edit the same numeric crop percentage used by Canvas.
  for(const handle of cropbox.querySelectorAll('.studio-crop-handle')){
    handle.addEventListener('pointerdown',e=>{
      if(tool.id!=='video-crop'||form.getAttribute('aria-busy')==='true')return;
      e.preventDefault();const startX=e.clientX,startY=e.clientY;
      const initial=Number(findValue(form,'crop'))||0;
      const box=surface.getBoundingClientRect();
      const dx=handle.classList.contains('tr')||handle.classList.contains('br')?-1:1;
      const dy=handle.classList.contains('bl')||handle.classList.contains('br')?-1:1;
      const move=event=>{
        const increment=50*((event.clientX-startX)*dx/Math.max(1,box.width)+(event.clientY-startY)*dy/Math.max(1,box.height));
        setValue(form,'crop',String(Math.round(cap(initial+increment,0,40))));
      };
      const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);
    });
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
    precisionLane?.setRange(start,end);
    if(trimWidget&&!syncGuard){const current=trimWidget.getRange();if(Math.abs(current.start-start)>.003||Math.abs(current.end-end)>.003){
      syncGuard=true;try{trimWidget.setRange(start,end);}finally{syncGuard=false;}
    }}
  }
  function updateTrimmer(elRange,name){if(!duration)return;
    const t=Math.round(Number(elRange.value)/1000*duration*1000)/1000;
    const other=name==='start'?(Number(findValue(form,'end'))||duration):Number(findValue(form,'start'))||0;
    const safe=name==='start'?Math.min(t,other-.001):Math.max(t,other+.001);
    setValue(form,name,cap(safe,0,duration).toFixed(3));seekVideo(video,safe);
  }
  listen(from,'input',()=>updateTrimmer(from,'start'));
  listen(to,'input',()=>updateTrimmer(to,'end'));
  listen(form,'input',event=>{
    // Редактор миллисекундных таймкодов не должен перезаписываться во время ввода.
    if(event.target.closest?.('.precision-editor'))return;
    updateEffect();updateTrim();
  });
  listen(form,'change',event=>{
    if(event.target.closest?.('.precision-editor'))return;
    updateEffect();updateTrim();
    if(event.target?.name==='seconds'&&!syncingFrame&&tool.id==='video-frames')seekVideo(video,Number(findValue(form,'seconds'))||0);
    if(['start','end'].includes(event.target?.name))recordTrim('');
    if(tool.id==='video-trim')trimWidget?.setKeyframes(findValue(form,'cutMode')==='keyframe'?knownKeyframes:[]);
  });
  listen(video,'error',()=>{
    if(!objectFile||destroyed)return;
    badge.textContent='Резервный экспорт';
    showError('Этот формат не воспроизводится в браузере. Для обработки можно использовать FFmpeg/WASM (суммарный размер файлов до 90 МиБ).');
  });
  listen(second,'error',()=>{
    if(!secondFile||destroyed)return;
    badge.textContent='Резервный экспорт';
    showError('Второй клип не декодируется в браузере. Экспорт попробует FFmpeg/WASM без отправки видео на сервер.');
  });
  listen(video,'loadedmetadata',()=>{
    if(!Number.isFinite(video.duration)||video.duration<=0){showError('Не удалось определить длительность видео. Попробуйте другой формат.');return;}
    duration=video.duration;
    time.textContent=`00:00 / ${prettyTime(duration)}`;resolution.textContent=`${video.videoWidth} × ${video.videoHeight}`;
    rangeControls.classList.toggle('hidden',tool.id!=='video-trim');
    if(tool.id==='video-trim'){
      precisionLane?.destroy();
      precisionLane=mountPrecisionTimeline(preciseHost,{duration,
        onSeek:point=>seekVideo(video,point),
        onRangeChange:range=>applyTrimRange(range.start,range.end,{mergeKey:'precise'})
      });
      const initial=trimState();trimHistory.reset(initial);updateHistoryButtons();
    }
    if(tool.id==='video-trim' && window.createTrimTimeline){
      trimWidget?.destroy();trimWidget=window.createTrimTimeline(sourceTimeline,{
        labels:{start:'Начало',end:'Конец',keep:'Оставить',setHint:'Поставить маркер'},
        onChange:(start,end)=>{
          // The visual handles are the source of the export settings.
          if(!syncGuard)applyTrimRange(start,end,{mergeKey:'drag',seek:false});
        },
        onScrub:point=>seekVideo(video,point)
      });
      trimWidget.load(objectFile,duration);
      const requestedToken=generation;
      void (async()=>{
        try{
          let api=null;
          if(/\.(mp4|m4v)$/i.test(objectFile?.name||'')){
            await import('./vendor/mp4-flatten.js');
            await import('./vendor/mp4-copy-trim.js');
            api=globalThis.Mp4CopyTrim;
          }else if(/\.webm$/i.test(objectFile?.name||'')){
            await import('./vendor/webm-copy-trim.js');
            api=globalThis.WebmCopyTrim;
          }
          if(!api?.keyframeTimes)return;
          const points=await api.keyframeTimes(objectFile);
          if(destroyed||requestedToken!==generation)return;
          knownKeyframes=points.filter(x=>Number.isFinite(x)&&x>=0&&x<=duration).slice(0,400);
          trimWidget?.setKeyframes(findValue(form,'cutMode')==='keyframe'?knownKeyframes:[]);
        }catch{
          // Unsupported containers continue to offer the ordinary trim markers.
        }
      })();
    }
    updateTrim();updateEffect();showCanvasMode();syncTime();
  });
  listen(video,'timeupdate',()=>{if(!multiKind)syncTime();if(!video.requestVideoFrameCallback)paintPreview();});
  listen(video,'seeked',paintPreview);
  listen(video,'loadeddata',paintPreview);
  listen(second,'loadeddata',paintPreview);
  listen(second,'seeked',paintPreview);
  listen(video,'play',()=>{if(!multiKind)play.textContent='Ⅱ';loopPreview();});
  listen(video,'pause',()=>{if(!multiKind)play.textContent='▶';stopPreviewLoop();paintPreview();});
  listen(video,'ended',()=>{if(!multiKind)play.textContent='▶';});
  listen(play,'click',()=>{if(multiKind)toggleProject();else if(video.paused)video.play().catch(()=>showError('Не удалось воспроизвести файл в этом браузере.'));else video.pause();});
  listen(back,'click',()=>seekProject((multiKind?projectTime:video.currentTime)-5));listen(forward,'click',()=>seekProject((multiKind?projectTime:video.currentTime)+5));
  listen(seek,'input',()=>seekProject(Number(seek.value)/1000*projectDuration()));
  listen(viewport,'keydown',e=>{if(e.target instanceof HTMLInputElement)return;
    if([' ','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();if(e.key===' ')play.click();else seekProject((multiKind?projectTime:video.currentTime)+(e.key==='ArrowRight'?5:-5));}
  });viewport.tabIndex=0;
  listen(shell,'keydown',e=>{
    if(!objectFile||form.getAttribute('aria-busy')==='true')return;
    const editable=e.target.closest?.('input,select,textarea,[contenteditable]');
    if(editable)return;
    const shortcut=e.ctrlKey||e.metaKey;
    if(shortcut&&e.key.toLowerCase()==='z'&&tool.id==='video-trim'){
      e.preventDefault();e.stopPropagation();restoreTrim(e.shiftKey?'redo':'undo');return;
    }
    if(shortcut&&e.key.toLowerCase()==='y'&&tool.id==='video-trim'){e.preventDefault();e.stopPropagation();restoreTrim('redo');return;}
    if(shortcut||e.altKey)return;
    if(['j','k','l','J','K','L'].includes(e.key)){
      e.preventDefault();if(e.key.toLowerCase()==='k'){if(multiKind)pauseProject();else video.pause();}else seekProject((multiKind?projectTime:video.currentTime)+(e.key.toLowerCase()==='j'?-1:1));
    }else if(tool.id==='video-trim'&&['[',']'].includes(e.key)){
      e.preventDefault();e.stopPropagation();const t=Math.round(video.currentTime*1000)/1000;
      const r=trimState();applyTrimRange(e.key==='['?t:r.start,e.key===']'?t:r.end,{mergeKey:''});
    }
  });
  function reset(){
    generation++;duration=0;knownKeyframes=[];pauseProject();stopPreviewLoop();stopAudioGraph();multiView?.destroy();multiView=null;multiLayout=null;projectTime=0;secondFile=null;
    trimWidget?.destroy();trimWidget=null;precisionLane?.destroy();precisionLane=null;trimHistory.reset({start:0,end:0});updateHistoryButtons();
    video.removeAttribute('src');second.removeAttribute('src');video.load();second.load();
    if(url)URL.revokeObjectURL(url);if(urlB)URL.revokeObjectURL(urlB);
    url=null;urlB=null;objectFile=null;frames.replaceChildren();seek.value='0';
    resolution.textContent='';time.textContent='00:00 / 00:00';renderedCanvas.width=0;renderedCanvas.height=0;
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
      placeholder.classList.remove('hidden');panel.classList.add('hidden');badge.textContent='Файл не выбран';historyButtons();return;
    }
    objectFile=first;
    placeholder.classList.add('hidden');panel.classList.remove('hidden');badge.textContent='Просмотр готов';
    url=URL.createObjectURL(first);video.src=url;video.load();showCanvasMode();
    if(files?.[1]&&isVideo(files[1])){secondFile=files[1];urlB=URL.createObjectURL(files[1]);second.src=urlB;second.classList.toggle('hidden',tool.id!=='split-screen');second.load();}
    else second.classList.add('hidden');
    const token=generation;
    void createFrames(first,token);
  }
  listen(second,'loadedmetadata',()=>{updateMulti();syncTime();paintPreview();});
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
  const placeholder=el('div','studio-placeholder');placeholder.append(el('div','studio-placeholder-icon','≡'),el('h3','','Выберите файл субтитров'),el('p','','После выбора файла здесь появятся реплики. Измените текст или время — правки войдут в результат.'));
  content.append(placeholder);
  const panel=el('div','studio-subtitles hidden');
  const controls=el('div','studio-sub-controls');
  const info=el('span','studio-hint','Правки хранятся до закрытия или обновления вкладки');
  const fileTabs=el('div','studio-file-tabs');
  const cueTimelineHost=el('div','studio-cue-timeline');
  const add=button('+ Реплика','secondary');
  const undo=button('↶ Отменить','studio-mini-button','Отменить изменение субтитров');undo.dataset.action='sub-undo';
  const redo=button('↷ Повторить','studio-mini-button','Повторить изменение субтитров');redo.dataset.action='sub-redo';
  controls.append(info,add,undo,redo);
  const preview=el('div','studio-sub-preview');const previewText=el('div','studio-sub-preview-text','Выберите реплику для просмотра.');preview.append(previewText);
  const list=el('div','studio-cue-list');panel.append(fileTabs,cueTimelineHost,preview,controls,list);content.append(panel);
  const status=el('div','studio-notice hidden');content.append(status);
  let tracks=[],active=0,revision=0,destroyed=false,loading=Promise.resolve(),selectedCue=0;
  const cueTimeline=mountSubtitleTimeline(cueTimelineHost,{
    onSelect:index=>{
      selectedCue=index;
      const cue=tracks[active]?.cues[index];
      if(cue)previewText.textContent=cue.text||'Пустая реплика';
      for(const [i,block] of [...cueTimelineHost.querySelectorAll('.subtitle-cue-block')].entries())block.classList.toggle('selected',i===index);
    },
    onChange:(index,updated,{mergeKey=''}={})=>{
      const track=tracks[active];if(!track||!track.cues[index]||destroyed)return;
      track.cues[index]={...track.cues[index],...updated};
      const row=list.children[index];
      const fields=row?.querySelectorAll('.studio-cue-timing input');
      if(fields?.length===2){fields[0].value=timeToText(updated.start);fields[1].value=timeToText(updated.end);}
      revision++;recordCue(mergeKey);
    }
  });
  const refreshCueTimeline=()=>cueTimeline.render(tracks[active]?.cues||[],selectedCue);
  const notifyEdit=()=>{root.dispatchEvent(new Event('lokit-editor-change',{bubbles:true}));};
  const historyButtons=()=>{const h=tracks[active]?.history;undo.disabled=!h?.canUndo;redo.disabled=!h?.canRedo;};
  const recordCue=(mergeKey='')=>{const track=tracks[active];track?.history?.record(track.cues,{mergeKey});historyButtons();refreshCueTimeline();notifyEdit();};
  function restoreCue(action){const track=tracks[active];const state=track?.history?.[action]();if(!state)return;track.cues=state;revision++;buildRows();historyButtons();notifyEdit();}
  undo.addEventListener('click',()=>restoreCue('undo'));redo.addEventListener('click',()=>restoreCue('redo'));
  listenSubtitleKeydown();
  function listenSubtitleKeydown(){shell.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='z')return;
    if(event.target.closest?.('input,textarea,[contenteditable]'))return;
    event.preventDefault();restoreCue(event.shiftKey?'redo':'undo');
  });}
  function buildRows(){
    const track=tracks[active];list.replaceChildren();if(!track){refreshCueTimeline();return;}
    badge.textContent=`Реплик: ${track.cues.length}`;
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
        cue.text=text.value;previewText.textContent=cue.text||'Пустая реплика';revision++;recordCue(document.activeElement===text?'text-'+i:'');};
      start.addEventListener('change',update);end.addEventListener('change',update);text.addEventListener('input',update);
      row.addEventListener('focusin',()=>{selectedCue=i;previewText.textContent=cue.text||'Пустая реплика';refreshCueTimeline();});
      remove.addEventListener('click',()=>{track.cues.splice(i,1);revision++;recordCue();buildRows();});
      row.append(number,timing,text,remove);list.append(row);
    }
    refreshCueTimeline();
  }
  function buildTabs(){fileTabs.replaceChildren();tracks.forEach((t,i)=>{const b=button(t.file.name,'studio-file-tab'+(i===active?' active':''));b.setAttribute('aria-pressed',String(i===active));b.addEventListener('click',()=>{active=i;buildTabs();buildRows();historyButtons();});fileTabs.append(b);});historyButtons();}
  add.addEventListener('click',()=>{const track=tracks[active];if(!track)return;
    const last=track.cues.at(-1)?.end||0;track.cues.push({start:last,end:last+2,text:'Новая реплика'});revision++;recordCue();buildRows();list.lastElementChild?.querySelector('textarea')?.focus();
  });
  async function loadFiles(files){
    const marker=++revision;tracks=[];active=0;selectedCue=0;status.classList.add('hidden');list.replaceChildren();
    if(!files?.length||!isSubtitle(files[0])){placeholder.classList.remove('hidden');panel.classList.add('hidden');badge.textContent='Файл не выбран';return;}
    for(const file of files.slice(0,2)){
      if(!isSubtitle(file))continue;
      try{
        const parsed=decodeSubtitle(await file.text());if(destroyed||marker!==revision)return;
        if(parsed.cues.length)tracks.push({...parsed,file,history:createEditHistory(parsed.cues)});
      }catch{ /* Показать понятное сообщение вместо падения */ }
    }
    if(destroyed||marker!==revision)return;
    if(!tracks.length){status.textContent='Не удалось найти реплики с корректным временем. Проверьте формат SRT/VTT: визуальное редактирование недоступно.';status.classList.remove('hidden');badge.textContent='Нет реплик';return;}
    placeholder.classList.add('hidden');panel.classList.remove('hidden');buildTabs();buildRows();
  }
  function update(files){loading=loadFiles(files);return loading;}
  async function getFiles(files){
    await loading;
    if(destroyed)throw new Error('Редактор уже закрыт');
    if(!tracks.length)return files;
    const found=new Map(tracks.map(track=>[track.file,track]));
    return files.map(file=>{
      const track=found.get(file);if(!track)return file;
      if(track.cues.some(c=>c.invalid||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.end<=c.start))throw new Error('Проверьте начало и конец каждой реплики.');
      const source=window.SubtitleSerializer?.[track.type==='vtt'?'toVtt':'toSrt'](track.cues)||encodeSubtitle(track.cues,track.type);
      return new File([source],file.name,{type:'text/plain;charset=utf-8',lastModified:Date.now()});
    });
  }
  function destroy(){destroyed=true;revision++;cueTimeline.destroy();shell.remove();}
  return {update,getFiles,destroy};
}

export function mountEditor({host,tool,form}){
  if(tool.isCapture)return createCaptureStudio(host,tool);
  if(tool.category==='Субтитры')return subtitleStudio(host,tool);
  return videoStudio(host,tool,form);
}
