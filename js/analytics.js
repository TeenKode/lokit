// Аналитика Lokit сохраняется исключительно на этом устройстве.
const KEY='lokit:analytics:v1';
const MAX_HISTORY=1200, DAY=86400000;
const KINDS=new Set(['view','open','success','error','cancelled']);
const read=()=>{try{const v=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(v)?v:[];}catch{return [];}};
const notify=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('lokit-analytics-updated'));};
const save=value=>{try{localStorage.setItem(KEY,JSON.stringify(value));}catch{}notify();};
const clamp=(n,max)=>Number.isFinite(Number(n))?Math.max(0,Math.min(max,Math.round(Number(n)))):0;
// От прежней опциональной внешней статистики не остаётся очереди отправки.
if(typeof localStorage!=='undefined')for(const key of ['lokit:analytics:queue:v1','lokit:analytics:share:v1','lokit:analytics:global-snapshot:v1'])try{localStorage.removeItem(key);}catch{}
export function localEvents(){return read().filter(e=>e&&KINDS.has(e.kind)&&Number.isFinite(Date.parse(e.ts)));}
export function clearLocalEvents(){save([]);}
export function exportLocalEvents(){return JSON.stringify({format:'lokit-analytics-v1',exportedAt:new Date().toISOString(),events:localEvents()},null,2);}
export function recordEvent(kind,tool='site',data={}){
  if(!KINDS.has(kind))return;
  const event={id:(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():null)||`local-${Date.now()}-${Math.random()}`,ts:new Date().toISOString(),kind,
    tool:/^[a-z0-9-]{2,48}$/.test(tool)?tool:'site',
    durationMs:clamp(data.durationMs,86400000),inputBytes:clamp(data.inputBytes,20*1024**3),outputBytes:clamp(data.outputBytes,20*1024**3)};
  save([...localEvents(),event].slice(-MAX_HISTORY));
}
export function recordOperation(tool,outcome,files,result,durationMs){
  const inputBytes=Array.isArray(files)?files.reduce((s,f)=>s+(f?.size||0),0):0;
  recordEvent(outcome,tool,{durationMs,inputBytes,outputBytes:result?.blob?.size||0});
}
export function summarizeLocal(days=30){
  const selectedDays=[7,30,90].includes(Number(days))?Number(days):30;
  const today=new Date();today.setUTCHours(0,0,0,0);
  const start=today.getTime()-(selectedDays-1)*DAY;
  const events=localEvents().filter(e=>Date.parse(e.ts)>=start&&Date.parse(e.ts)<=Date.now()+300000);
  const kinds=new Map(), tools=new Map(), daily=new Map();
  for(const event of events){
    kinds.set(event.kind,(kinds.get(event.kind)||0)+1);
    if(event.tool!=='site'){
      const item=tools.get(event.tool)||{tool:event.tool,opens:0,success:0,error:0,cancelled:0,durationMs:0,inputBytes:0,outputBytes:0};
      if(event.kind==='open')item.opens++;
      if(['success','error','cancelled'].includes(event.kind)){
        item[event.kind]++;item.durationMs+=event.durationMs||0;
        if(event.kind==='success'){item.inputBytes+=event.inputBytes||0;item.outputBytes+=event.outputBytes||0;}
      }
      tools.set(event.tool,item);
    }
    const day=event.ts.slice(0,10), item=daily.get(day)||{day,view:0,open:0,success:0,error:0,cancelled:0};
    item[event.kind]++;daily.set(day,item);
  }
  return {version:1,days:selectedDays,kinds:Array.from(kinds,([kind,count])=>({kind,count})),tools:Array.from(tools.values()),daily:Array.from(daily.values()).sort((a,b)=>a.day.localeCompare(b.day))};
}
if(typeof window!=='undefined')window.addEventListener('storage',e=>{if(e.key===KEY)notify();});
