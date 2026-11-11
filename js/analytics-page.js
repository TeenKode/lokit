import {tools} from './tools.js';
import './version.js';
import {localEvents,recordEvent,clearLocalEvents,exportLocalEvents,summarizeLocal} from './analytics.js';

const $=selector=>document.querySelector(selector);
const toolNames=new Map(tools.map(t=>[t.id,t.title]));
const LABELS={view:'Открытие страницы',open:'Выбор инструмента',success:'Успешно',error:'Ошибка',cancelled:'Отменено'};
const nf=new Intl.NumberFormat('ru-RU');
let days=30;
const count=(stats,kind)=>Number(stats.kinds?.find(entry=>entry.kind===kind)?.count||0);
const formatCount=value=>nf.format(Number(value)||0);
const fmtDuration=value=>{const seconds=Math.round((Number(value)||0)/1000);return seconds<60?`${seconds} с`:seconds<3600?`${Math.floor(seconds/60)} мин ${seconds%60} с`:`${Math.floor(seconds/3600)} ч ${Math.floor(seconds/60)%60} мин`;};
const fmtBytes=value=>{const n=Math.max(0,Number(value)||0);return n<1024?`${n} Б`:n<1024**2?`${(n/1024).toFixed(1)} КБ`:n<1024**3?`${(n/1024**2).toFixed(1)} МБ`:`${(n/1024**3).toFixed(2)} ГБ`;};
function status(text,error=false){const el=$('#analytics-message');el.textContent=text;el.classList.toggle('error',error);el.classList.toggle('hidden',!text);}
function put(node,text){$(node).textContent=text;}
function emptyState(text){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.className='table-empty';td.textContent=text;row.append(td);return row;}

function renderMetrics(stats){
  const views=count(stats,'view'),opens=count(stats,'open'),success=count(stats,'success'),errors=count(stats,'error'),cancelled=count(stats,'cancelled');
  const completed=success+errors+cancelled;
  const toolStats=stats.tools||[];
  const totalDuration=toolStats.reduce((sum,tool)=>sum+(Number(tool.durationMs)||0),0);
  const bytes=toolStats.reduce((sum,tool)=>sum+(Number(tool.inputBytes)||0),0);
  put('#metric-views',formatCount(views));put('#metric-opens',formatCount(opens));put('#metric-success',formatCount(success));
  put('#metric-success-rate',completed?`${Math.round(success/completed*100)}% успешных завершений`:'Пока нет завершённых операций');
  put('#metric-time',completed?fmtDuration(totalDuration/completed):'—');
  put('#metric-errors',formatCount(errors));put('#metric-bytes',fmtBytes(bytes));
}
function renderChart(stats){
  const root=$('#analytics-chart');root.replaceChildren();
  const source=new Map((stats.daily||[]).map(item=>[item.day,item]));
  const today=new Date();today.setUTCHours(0,0,0,0);
  const bars=[];
  for(let i=days-1;i>=0;i--){
    const date=new Date(today);date.setUTCDate(today.getUTCDate()-i);
    const day=date.toISOString().slice(0,10);
    const values=source.get(day)||{};
    const success=Number(values.success||0),open=Number(values.open||0),other=Number(values.view||0)+Number(values.error||0)+Number(values.cancelled||0);
    bars.push({day,success,open,other,total:success+open+other});
  }
  const max=Math.max(1,...bars.map(item=>item.total));
  for(const item of bars){
    const bar=document.createElement('div');bar.className='activity-day';bar.title=`${item.day}: событий ${item.total}, успешных операций ${item.success}, открытий инструментов ${item.open}`;
    const stack=document.createElement('div');stack.className='activity-stack';
    for(const [key,label] of [['other','other'],['open','open'],['success','success']]){
      if(item[key]===0)continue;
      const segment=document.createElement('span');segment.className=`activity-segment segment-${label}`;segment.style.height=`${Math.max(2,item[key]/max*100)}%`;stack.append(segment);
    }
    bar.append(stack);
    const label=document.createElement('span');label.className='activity-date';label.textContent=days===7?item.day.slice(5):item.day.slice(8);
    bar.append(label);root.append(bar);
  }
  root.setAttribute('aria-label',`Активность за ${days} дней: ${bars.reduce((n,item)=>n+item.total,0)} событий`);
}
function renderTools(stats){
  const body=$('#analytics-tools');body.replaceChildren();
  const values=[...(stats.tools||[])].sort((a,b)=>(b.opens+b.success)-(a.opens+a.success)||String(a.tool).localeCompare(String(b.tool)));
  if(!values.length){body.append(emptyState('За этот период событий нет.'));return;}
  for(const item of values){
    const row=document.createElement('tr');
    const completed=Number(item.success||0)+Number(item.error||0)+Number(item.cancelled||0);
    for(const value of [toolNames.get(item.tool)||item.tool,formatCount(item.opens),formatCount(item.success),formatCount(item.error),formatCount(item.cancelled),completed?fmtDuration(item.durationMs/completed):'—']){
      const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);
    }
    body.append(row);
  }
}
function renderHistory(){
  const body=$('#analytics-history');body.replaceChildren();
  const today=new Date();today.setUTCHours(0,0,0,0);
  const start=today.getTime()-(days-1)*86400000;
  const values=localEvents().filter(e=>Date.parse(e.ts)>=start).slice(-40).reverse();
  if(!values.length){body.append(emptyState('История пока пуста.'));return;}
  for(const event of values){
    const row=document.createElement('tr');
    for(const value of [new Date(event.ts).toLocaleString('ru-RU'),LABELS[event.kind]||event.kind,toolNames.get(event.tool)||'Сайт',event.durationMs?fmtDuration(event.durationMs):'—']){
      const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);
    }
    body.append(row);
  }
}
function refresh(){
  const stats=summarizeLocal(days);
  renderMetrics(stats);renderChart(stats);renderTools(stats);renderHistory();
  status(`Статистика за ${days} дней. История хранится только в этом браузере.`);
}
$('#analytics-range').addEventListener('change',e=>{days=Number(e.target.value)||30;void refresh();});
$('#analytics-refresh').addEventListener('click',refresh);
$('#analytics-export').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([exportLocalEvents()],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='lokit-analytics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
});
$('#analytics-clear').addEventListener('click',()=>{
  if(!confirm('Удалить всю историю использования в этом браузере? Отменить действие нельзя.'))return;
  clearLocalEvents();void refresh();
});
window.addEventListener('lokit-analytics-updated',refresh);
recordEvent('view');
void refresh();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{}));
