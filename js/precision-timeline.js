/** Pure millisecond timeline geometry, plus an accessible zoomed navigation lane. */
export function clampTime(time,duration){return Math.min(Math.max(0,Number(time)||0),Math.max(0,Number(duration)||0));}
export function timelineWindow(duration,zoom=1,center=0){
  const total=Math.max(0,Number(duration)||0);
  const factor=Math.min(32,Math.max(1,Number(zoom)||1));
  if(!total)return {start:0,end:0,span:0,zoom:factor};
  const span=total/factor;
  const start=Math.min(Math.max(0,center-span/2),total-span);
  return {start,end:start+span,span,zoom:factor};
}
export function positionInWindow(time,view){return view.span?100*(time-view.start)/view.span:0;}
export function stepFrame(time,frameRate,direction,duration){
  const rate=Number(frameRate);
  if(!Number.isFinite(rate)||rate<=0||rate>240)throw new Error('Неподдерживаемая частота кадров');
  if(direction!==-1&&direction!==1)throw new RangeError('Направление шага должно быть -1 или 1');
  return Math.round(clampTime(Number(time)+direction/rate,duration)*1000)/1000;
}
export function formatTimecode(seconds){
  const ms=Math.max(0,Math.round((Number(seconds)||0)*1000));
  const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}
export function parseTimecode(text){
  const value=String(text??'').trim().replace(',','.');
  if(/^\d+(?:\.\d{1,3})?$/.test(value))return Number(value);
  const parts=value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if(!parts)return NaN;
  const h=Number(parts[1]||0),m=Number(parts[2]),s=Number(parts[3]);
  if(m>59||s>59)return NaN;
  return h*3600+m*60+s+Number((parts[4]||'0').padEnd(3,'0'))/1000;
}
/** The DOM lane exposes seconds, but every seek/range input operates in whole milliseconds. */
export function mountPrecisionTimeline(host,{duration=0,onSeek=()=>{},onRangeChange=()=>{},getPlayhead=()=>0}={}){
  const make=(tag,cls='',content='')=>{const el=document.createElement(tag);el.className=cls;el.textContent=content;return el;};
  const button=(text,title)=>{const el=make('button','precision-button',text);el.type='button';el.title=title||text;return el;};
  const root=make('section','precision-editor');root.setAttribute('aria-label','Подробная временная шкала');
  const toolbar=make('div','precision-toolbar');const title=make('strong','','Точная настройка времени');
  const zoomOut=button('−','Уменьшить масштаб'),zoomIn=button('+','Увеличить масштаб');
  zoomOut.dataset.action='zoom-out';zoomIn.dataset.action='zoom-in';
  const zoomText=make('span','precision-zoom','1×');zoomText.setAttribute('aria-live','polite');
  const panLeft=button('◀','Сдвинуть шкалу влево'),panRight=button('▶','Сдвинуть шкалу вправо');
  toolbar.append(title,panLeft,zoomOut,zoomText,zoomIn,panRight);
  const ruler=make('div','precision-ruler');
  const bar=make('div','precision-lane');const segment=make('div','precision-selection');const left=make('div','precision-marker precision-start');const right=make('div','precision-marker precision-end');const play=make('div','precision-marker precision-play');
  const seek=make('input','precision-scrub');seek.type='range';seek.step='1';seek.min='0';seek.max='1000';seek.value='0';seek.setAttribute('aria-label','Положение курсора на увеличенной временной шкале');
  bar.append(segment,left,right,play,seek);
  const fields=make('div','precision-fields');
  const startLabel=make('label','precision-field','Начало');const startInput=make('input');startInput.type='text';startInput.setAttribute('aria-label','Точное начало ЧЧ:ММ:СС.мс');startInput.placeholder='00:00:00.000';startInput.dataset.trim='start';startLabel.append(startInput);
  const endLabel=make('label','precision-field','Конец');const endInput=make('input');endInput.type='text';endInput.setAttribute('aria-label','Точный конец ЧЧ:ММ:СС.мс');endInput.placeholder='00:00:00.000';endInput.dataset.trim='end';endLabel.append(endInput);
  const fpsLabel=make('label','precision-field','Шаг по кадрам');const fps=make('select');fps.setAttribute('aria-label','Частота для пошагового перемещения');for(const [value,label] of [['24','24 FPS'],['25','25 FPS'],['30','30 FPS'],['29.97','29,97 FPS'],['50','50 FPS'],['60','60 FPS']]){const opt=make('option','',label);opt.value=value;fps.append(opt);}fps.value='30';fpsLabel.append(fps);
  const backward=button('−1 кадр','Назад на один расчётный кадр'),forward=button('+1 кадр','Вперёд на один расчётный кадр');backward.dataset.action='frame-back';forward.dataset.action='frame-next';
  fields.append(startLabel,endLabel,fpsLabel,backward,forward);
  const hint=make('p','precision-hint','Укажите начало и конец с точностью до миллисекунды. Реальная точность результата зависит от формата и способа экспорта.');
  root.append(toolbar,ruler,bar,fields,hint);host.append(root);
  let total=Math.max(0,Number(duration)||0),zoom=1,center=total/2,selected={start:0,end:total},current=0,disabled=false;
  const unsub=[];
  const listen=(node,event,fn)=>{node.addEventListener(event,fn);unsub.push([node,event,fn]);};
  const markers=()=>{
    const view=timelineWindow(total,zoom,center);
    const pos=t=>positionInWindow(t,view);
    for(const [node,time] of [[left,selected.start],[right,selected.end],[play,current]]){
      const value=pos(time);node.style.left=`${Math.min(100,Math.max(0,value))}%`;node.hidden=value<0||value>100;
    }
    const lo=Math.max(0,Math.min(100,pos(selected.start))),hi=Math.max(0,Math.min(100,pos(selected.end)));
    segment.style.left=lo+'%';segment.style.width=Math.max(0,hi-lo)+'%';
    seek.min=String(Math.round(view.start*1000));seek.max=String(Math.max(Number(seek.min)+1,Math.round(view.end*1000)));
    seek.value=String(Math.round(Math.min(view.end,Math.max(view.start,current))*1000));
    ruler.replaceChildren();
    for(let i=0;i<=6;i++){
      const tick=make('span','precision-tick',formatTimecode(view.start+view.span*i/6));tick.style.left=`${100*i/6}%`;ruler.append(tick);
    }
    zoomText.textContent=`${zoom}×`;
    zoomOut.disabled=disabled||zoom<=1;zoomIn.disabled=disabled||zoom>=32;
    panLeft.disabled=disabled||view.start<=0;panRight.disabled=disabled||view.end>=total;
  };
  const refreshInputs=()=>{startInput.value=formatTimecode(selected.start);endInput.value=formatTimecode(selected.end);};
  const pan=direction=>{const view=timelineWindow(total,zoom,center);center=Math.min(total,Math.max(0,center+direction*view.span*.6));markers();};
  listen(zoomOut,'click',()=>{zoom=Math.max(1,zoom/2);markers();});listen(zoomIn,'click',()=>{zoom=Math.min(32,zoom*2);center=current;markers();});
  listen(panLeft,'click',()=>pan(-1));listen(panRight,'click',()=>pan(1));
  listen(seek,'input',()=>{if(!disabled){current=Number(seek.value)/1000;onSeek(current);markers();}});
  const changeBoundary=(which,input)=>{
    if(disabled)return;
    const value=parseTimecode(input.value);
    if(!Number.isFinite(value)||value<0||value>total||(which==='start'?value>=selected.end:value<=selected.start)){
      input.setCustomValidity('Укажите время в пределах видео: конец должен быть позже начала.');input.reportValidity();input.setCustomValidity('');refreshInputs();return;
    }
    input.setCustomValidity('');selected={...selected,[which]:Math.round(value*1000)/1000};onRangeChange({...selected});markers();refreshInputs();
  };
  listen(startInput,'change',()=>changeBoundary('start',startInput));listen(endInput,'change',()=>changeBoundary('end',endInput));
  const frame=dir=>{if(disabled)return;current=stepFrame(current,Number(fps.value),dir,total);onSeek(current);markers();};
  listen(backward,'click',()=>frame(-1));listen(forward,'click',()=>frame(1));
  markers();refreshInputs();
  return {
    root,
    setDuration(value){total=Math.max(0,Number(value)||0);center=total/2;selected={start:0,end:total};current=0;markers();refreshInputs();},
    setRange(start,end){selected={start:clampTime(start,total),end:clampTime(end,total)};markers();refreshInputs();},
    setPlayhead(time){current=clampTime(time,total);markers();},
    step:frame,
    zoomTo(factor){zoom=Math.min(32,Math.max(1,factor));center=current;markers();},
    setDisabled(value){disabled=Boolean(value);for(const node of [seek,startInput,endInput,fps,backward,forward])node.disabled=disabled;markers();},
    destroy(){for(const [node,event,fn] of unsub)node.removeEventListener(event,fn);root.remove();}
  };
}
