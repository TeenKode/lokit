/** Shared timeline geometry for multi-clip editing. All times are seconds. */
const clamp=(n,a,b)=>Math.min(b,Math.max(a,Number(n)||0));
export function multiTrackLayout(kind,durations,{order='normal',offset=0,loops=1,speed=1}={}){
  const a=Math.max(0,Number(durations[0])||0),b=Math.max(0,Number(durations[1])||0);
  if(kind==='merge'){
    const clips=order==='reverse'?[{source:1,start:0,end:b},{source:0,start:b,end:b+a}]:[{source:0,start:0,end:a},{source:1,start:a,end:a+b}];
    return {total:a+b,tracks:[clips],clips};
  }
  if(kind==='split'){
    const delay=Math.max(0,Number(offset)||0);
    return {total:Math.max(a,delay+b),tracks:[[{source:0,start:0,end:a}],[{source:1,start:delay,end:delay+b}]]};
  }
  if(kind==='loop'){
    const count=clamp(Math.floor(loops),1,10);const clips=Array.from({length:count},(_,i)=>({source:0,start:i*a,end:(i+1)*a}));
    return {total:a*count,tracks:[clips],clips};
  }
  if(kind==='speed')return {total:a/clamp(speed,.25,4),tracks:[[{source:0,start:0,end:a/clamp(speed,.25,4)}]]};
  return {total:a,tracks:[[{source:0,start:0,end:a}]]};
}
export function locateMergeTime(layout,time){
  const total=layout.total,t=clamp(time,0,total);
  const clip=layout.clips?.find((entry,index)=>t<entry.end||index===layout.clips.length-1);
  return clip?{source:clip.source,time:clamp(t-clip.start,0,clip.end-clip.start)}:{source:0,time:0};
}
export function globalMergeTime(layout,source,localTime){
  const clip=layout.clips?.find(entry=>entry.source===source);
  return clip?clamp(clip.start+localTime,0,layout.total):0;
}
export function splitSourceTime(globalTime,offset,duration){return clamp(globalTime-Math.max(0,Number(offset)||0),0,duration);}
const fmt=t=>{const ms=Math.max(0,Math.round(t*1000));return `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
/** Lightweight accessible multitrack view; actual export consumes the same order/offset options. */
export function mountMultiTrack(host,{kind,onSeek=()=>{},onChange=()=>{}}={}){
  const root=document.createElement('section');root.className='multi-timeline';root.setAttribute('aria-label','Многодорожечный таймлайн');
  const heading=document.createElement('div');heading.className='multi-heading';
  const title=document.createElement('strong');title.textContent=kind==='merge'?'Монтажная последовательность':kind==='split'?'Две видеодорожки':kind==='loop'?'Повторения': 'Временная шкала';
  const total=document.createElement('span');total.className='multi-total';heading.append(title,total);
  const lanes=document.createElement('div');lanes.className='multi-lanes';
  const ruler=document.createElement('div');ruler.className='multi-ruler';
  const scrub=document.createElement('input');scrub.className='multi-scrub';scrub.type='range';scrub.min='0';scrub.max='1000';scrub.step='1';scrub.value='0';scrub.setAttribute('aria-label','Позиция на монтажной шкале');
  root.append(heading,lanes,ruler,scrub);host.append(root);
  let current={total:0,tracks:[]},position=0;
  const render=(layout,filenames=['Видео 1','Видео 2'])=>{
    current=layout;lanes.replaceChildren();ruler.replaceChildren();total.textContent=`Итоговая длительность: ${fmt(layout.total)}`;
    for(const [row,clips] of layout.tracks.entries()){
      const track=document.createElement('div');track.className='multi-lane';track.setAttribute('aria-label',`Дорожка ${row+1}`);
      for(const clip of clips){
        const pill=document.createElement('button');pill.type='button';pill.className=`multi-clip multi-clip-${clip.source}`;
        const width=Math.max(0,100*(clip.end-clip.start)/(layout.total||1));
        pill.style.left=(100*clip.start/(layout.total||1))+'%';pill.style.width=width+'%';
        pill.textContent=filenames[clip.source]||`Клип ${clip.source+1}`;
        pill.title=`${pill.textContent}: ${fmt(clip.start)} – ${fmt(clip.end)}`;
        pill.addEventListener('click',()=>onSeek(clip.start));track.append(pill);
      }
      lanes.append(track);
    }
    for(let i=0;i<=4;i++){const mark=document.createElement('span');mark.textContent=fmt(layout.total*i/4);ruler.append(mark);}
    scrub.disabled=layout.total<=0;setPlayhead(position);
  };
  const setPlayhead=t=>{position=clamp(t,0,current.total);scrub.value=String(current.total?Math.round(1000*position/current.total):0);};
  scrub.addEventListener('input',()=>{position=current.total*Number(scrub.value)/1000;onSeek(position);});
  const destroy=()=>root.remove();
  return {root,render,setPlayhead,destroy};
}
