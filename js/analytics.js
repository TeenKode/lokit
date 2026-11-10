import {GLOBAL_ANALYTICS_URL} from './analytics-config.js';

const EVENTS_KEY='lokit:analytics:v1';
const QUEUE_KEY='lokit:analytics:queue:v1';
const SHARING_KEY='lokit:analytics:share:v1';
const MAX_HISTORY=1200;
const DAY_MS=86400000;
const MAX_QUEUE=150;
const VALID_KINDS=new Set(['view','open','success','error','cancelled']);
const MAX_VALUE=20*1024*1024*1024;
let flushing=null;
let inFlight=null;

function safeRead(key,fallback){
  try {const value=localStorage.getItem(key);return value===null?fallback:JSON.parse(value);}catch{return fallback;}
}
function safeSave(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function eventId(){
  if(globalThis.crypto?.randomUUID)return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function clamp(n,max){return Number.isFinite(Number(n))?Math.max(0,Math.min(max,Math.round(Number(n)))):0;}
export function apiUrl(){
  try{
    const url=new URL(GLOBAL_ANALYTICS_URL);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='')return '';
    if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))return '';
    return url.origin;
  }catch{return '';}
}
export function isGlobalConnected(){return Boolean(apiUrl());}
// Новые посетители дают согласие на отправку статистики явно.
// Ранее сохранённый выбор не изменяется при обновлении сайта.
export function isSharingEnabled(){return safeRead(SHARING_KEY,false)===true;}
export function setSharingEnabled(value){
  safeSave(SHARING_KEY,Boolean(value));
  if(!value){inFlight?.abort();safeSave(QUEUE_KEY,[]);}
  else if(safeRead(QUEUE_KEY,[]).length)void flushPending();
  dispatchEvent(new Event('lokit-analytics-updated'));
}
export function localEvents(){
  const result=safeRead(EVENTS_KEY,[]);
  return Array.isArray(result)?result.filter(e=>e&&VALID_KINDS.has(e.kind)&&typeof e.ts==='string'):[];
}
export function pendingEventCount(){
  const queue=safeRead(QUEUE_KEY,[]);
  return Array.isArray(queue)?queue.length:0;
}
export function clearLocalEvents(){
  inFlight?.abort();
  safeSave(EVENTS_KEY,[]);
  safeSave(QUEUE_KEY,[]);
  dispatchEvent(new Event('lokit-analytics-updated'));
}
export function exportLocalEvents(){
  return JSON.stringify({format:'lokit-analytics-v1',exportedAt:new Date().toISOString(),events:localEvents()},null,2);
}
export function recordEvent(kind,tool='site',data={}){
  if(!VALID_KINDS.has(kind))return;
  const event={
    id:eventId(),ts:new Date().toISOString(),kind,
    tool:typeof tool==='string'&&/^[a-z0-9-]{2,48}$/.test(tool)?tool:'site',
    durationMs:clamp(data.durationMs,24*60*60*1000),
    inputBytes:clamp(data.inputBytes,MAX_VALUE),
    outputBytes:clamp(data.outputBytes,MAX_VALUE)
  };
  const events=localEvents();events.push(event);
  safeSave(EVENTS_KEY,events.slice(-MAX_HISTORY));
  if(isGlobalConnected()&&isSharingEnabled()){
    const queue=safeRead(QUEUE_KEY,[]);
    if(Array.isArray(queue)){
      queue.push(event);
      safeSave(QUEUE_KEY,queue.slice(-MAX_QUEUE));
    }
    void flushPending();
  }
  dispatchEvent(new Event('lokit-analytics-updated'));
}
export function recordOperation(tool,outcome,files,result,durationMs){
  const inputBytes=Array.isArray(files)?files.reduce((sum,file)=>sum+(file?.size||0),0):0;
  recordEvent(outcome,tool,{inputBytes,outputBytes:result?.blob?.size||0,durationMs});
}

export async function flushPending(){
  const url=apiUrl();
  if(!url||!isSharingEnabled()||!navigator.onLine)return false;
  if(flushing)return flushing;
  flushing=(async()=>{
    for(let round=0;round<5;round++){
      const all=safeRead(QUEUE_KEY,[]);
      if(!Array.isArray(all)||!all.length)return true;
      const now=Date.now();
      const stillValid=all.filter(e=>e&&Number.isFinite(Date.parse(e.ts))&&Date.parse(e.ts)>=now-6.9*DAY_MS&&Date.parse(e.ts)<=now+5*60000);
      if(stillValid.length!==all.length)safeSave(QUEUE_KEY,stillValid);
      if(!stillValid.length)return true;
      const toSend=stillValid.slice(0,30);
      const controller=new AbortController();
      inFlight=controller;
      const timeout=setTimeout(()=>controller.abort(),12000);
      try{
        if(!isSharingEnabled())return false;
        const response=await fetch(`${url}/api/events`,{
          method:'POST',mode:'cors',credentials:'omit',cache:'no-store',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({events:toSend}),signal:controller.signal
        });
        if(!response.ok)return false;
        // Не удаляем события, появившиеся во время запроса.
        const sent=new Set(toSend.map(e=>e.id));
        const current=safeRead(QUEUE_KEY,[]);
        if(Array.isArray(current)){safeSave(QUEUE_KEY,current.filter(e=>!sent.has(e.id)));dispatchEvent(new Event('lokit-analytics-updated'));}
      }catch{return false;}
      finally{clearTimeout(timeout);if(inFlight===controller)inFlight=null;}
    }
    return true;
  })();
  let succeeded=false;
  try{const result=await flushing;succeeded=result;return result;}
  finally{
    flushing=null;
    // События могли появиться на границе завершения предыдущей отправки.
    if(succeeded&&isSharingEnabled()&&navigator.onLine&&safeRead(QUEUE_KEY,[]).length)
      queueMicrotask(()=>void flushPending());
  }
}

export async function loadGlobalStats(days=30){
  const url=apiUrl();
  if(!url)throw new Error('Сервер общей статистики ещё не подключён.');
  const period=[7,30,90].includes(Number(days))?Number(days):30;
  const response=await fetch(`${url}/api/stats?days=${period}`,{
    credentials:'omit',cache:'no-store',signal:AbortSignal.timeout?AbortSignal.timeout(12000):undefined
  });
  if(!response.ok)throw new Error(`Сервер статистики ответил кодом ${response.status}.`);
  const data=await response.json();
  if(data?.version!==1||!Array.isArray(data.daily)||!Array.isArray(data.tools)||!Array.isArray(data.kinds))throw new Error('Неверный формат статистики.');
  return data;
}

export function summarizeLocal(days=30){
  // Сопоставляем календарные дни UTC с серверной агрегацией и графиком,
  // а не скользящие 24-часовые окна, которые теряют часть первого дня.
  const selectedDays=[7,30,90].includes(Number(days))?Number(days):30;
  const today=new Date();today.setUTCHours(0,0,0,0);
  const threshold=today.getTime()-(selectedDays-1)*DAY_MS;
  const events=localEvents().filter(e=>{const time=Date.parse(e.ts);return Number.isFinite(time)&&time>=threshold&&time<=Date.now()+5*60000;});
  const kinds=new Map();const tools=new Map();const daily=new Map();
  for(const item of events){
    kinds.set(item.kind,(kinds.get(item.kind)||0)+1);
    if(item.tool!=='site'){
      const found=tools.get(item.tool)||{tool:item.tool,opens:0,success:0,error:0,cancelled:0,durationMs:0,inputBytes:0,outputBytes:0};
      if(item.kind==='open')found.opens++;
      if(['success','error','cancelled'].includes(item.kind)){
        found[item.kind]++;found.durationMs+=item.durationMs||0;
        if(item.kind==='success'){found.inputBytes+=item.inputBytes||0;found.outputBytes+=item.outputBytes||0;}
      }
      tools.set(item.tool,found);
    }
    const day=item.ts.slice(0,10);const current=daily.get(day)||{day,view:0,open:0,success:0,error:0,cancelled:0};
    current[item.kind]++;daily.set(day,current);
  }
  return {version:1,days:selectedDays,kinds:Array.from(kinds,([kind,count])=>({kind,count})),tools:Array.from(tools.values()),daily:Array.from(daily.values()).sort((a,b)=>a.day.localeCompare(b.day))};
}

if(typeof window!=='undefined'){
  window.addEventListener('online',()=>void flushPending());
  window.addEventListener('storage',event=>{if([EVENTS_KEY,QUEUE_KEY,SHARING_KEY].includes(event.key))dispatchEvent(new Event('lokit-analytics-updated'));});
  // Отправить ранее накопленную статистику после открытия страницы, если backend подключён.
  if(isGlobalConnected())void flushPending();
}
