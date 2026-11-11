/** Cue-block timeline: visible timing and editable start/end via pointer or keyboard. */
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
export function adjustCue(cues,index,part,newTime){
  const cue=cues[index];if(!cue)return null;
  const t=Number(newTime);
  if(!Number.isFinite(t)||t<0)return null;
  const next={...cue};
  if(part==='start')next.start=clamp(t,0,Math.max(0,Number(cue.end)-.001));
  else if(part==='end')next.end=Math.max(Number(cue.start)+.001,t);
  else{const len=cue.end-cue.start;next.start=Math.max(0,t);next.end=next.start+len;}
  if(next.end<=next.start)return null;
  return next;
}
export function mountSubtitleTimeline(host,{onSelect=()=>{},onChange=()=>{}}={}){
  const wrap=document.createElement('section');wrap.className='subtitle-lane-wrap';wrap.setAttribute('aria-label','Временная шкала субтитров');
  const head=document.createElement('div');head.className='multi-heading';
  const title=document.createElement('strong');title.textContent='Реплики на шкале';
  const help=document.createElement('span');help.textContent='Перетаскивайте реплики и их края. Стрелки перемещают на 0,1 с.';help.className='studio-hint';head.append(title,help);
  const track=document.createElement('div');track.className='subtitle-lane';
  const ruler=document.createElement('div');ruler.className='multi-ruler';wrap.append(head,track,ruler);host.append(wrap);
  let cues=[],duration=1,active=-1,disabled=false;
  function render(nextCues=[],selected=-1){
    cues=nextCues;active=selected;
    duration=Math.max(1,...cues.map(c=>Number(c.end)||0));
    track.replaceChildren();ruler.replaceChildren();
    for(const [index,cue] of cues.entries()){
      const block=document.createElement('div');block.className='subtitle-cue-block'+(index===active?' selected':'');
      block.style.left=`${100*cue.start/duration}%`;block.style.width=`${Math.max(.4,100*(cue.end-cue.start)/duration)}%`;
      const cueText=typeof cue.text==='string'?cue.text:'';
      block.tabIndex=0;block.setAttribute('role','group');block.setAttribute('aria-label',`Реплика ${index+1}: ${cueText.slice(0,70)}`);
      const label=document.createElement('span');label.textContent=cueText||`Реплика ${index+1}`;
      const left=document.createElement('button'),right=document.createElement('button');
      left.type=right.type='button';left.className='subtitle-handle start';right.className='subtitle-handle end';
      left.setAttribute('aria-label',`Переместить начало реплики ${index+1}`);right.setAttribute('aria-label',`Переместить конец реплики ${index+1}`);
      block.append(left,label,right);
      block.addEventListener('focusin',()=>onSelect(index));
      block.addEventListener('keydown',e=>{
        if(disabled||!['ArrowLeft','ArrowRight'].includes(e.key))return;
        const step=e.shiftKey?1:.1;
        const part=e.target===left?'start':e.target===right?'end':'move';
        const value=part==='end'?cue.end:cue.start;
        const updated=adjustCue(cues,index,part,value+(e.key==='ArrowRight'?step:-step));
        if(updated){e.preventDefault();onChange(index,updated);}
      });
      function drag(e,part){
        if(disabled||e.button!==0)return;e.preventDefault();
        onSelect(index);const box=track.getBoundingClientRect(),startX=e.clientX,initial={...cue};
        const handleMove=move=>{
          const delta=(move.clientX-startX)/Math.max(1,box.width)*duration;
          const updated=adjustCue([initial],0,part,(part==='end'?initial.end:initial.start)+delta);
          if(updated)onChange(index,updated,{mergeKey:`cue-${index}-${part}`});
        };
        const finish=()=>{window.removeEventListener('pointermove',handleMove);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};
        window.addEventListener('pointermove',handleMove);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);
      }
      block.addEventListener('pointerdown',e=>{if(e.target===left||e.target===right)return;drag(e,'move');});
      left.addEventListener('pointerdown',e=>drag(e,'start'));
      right.addEventListener('pointerdown',e=>drag(e,'end'));
      track.append(block);
    }
    for(let i=0;i<=4;i++){const marker=document.createElement('span');marker.textContent=(duration*i/4).toFixed(1)+' с';ruler.append(marker);}
  }
  return {root:wrap,render,setDisabled:value=>{disabled=Boolean(value);wrap.classList.toggle('disabled',disabled);},destroy(){wrap.remove();}};
}
