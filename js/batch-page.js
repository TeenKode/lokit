import {tools} from './tools.js';
import {readPreset,savePreset} from './presets.js';
import {recordOperation,recordEvent} from './analytics.js';
import {BatchQueue,groupFiles,isBatchTool} from './batch-queue.js';
import {createZip} from './zip.js';
import './version.js';

const $=id=>document.getElementById(id);
const form=$('batch-form'),toolSelect=$('batch-tool'),filesInput=$('batch-files');
const optionRoot=$('batch-options'),itemsRoot=$('batch-items');
const selectedFiles=$('batch-file-list'),fileHint=$('batch-file-hint');
const jobNodes=new Map();
const reported=new Set();
let exportAbort=null,exporting=false;
const fmtMs=ms=>{const secs=Math.floor(Math.max(0,ms)/1000);return `${String(Math.floor(secs/3600)).padStart(2,'0')}:${String(Math.floor(secs/60)%60).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;};
const wordForm=(count,[one,few,many])=>{const n=Math.abs(count)%100,d=n%10;return n>=11&&n<=14?many:d===1?one:d>=2&&d<=4?few:many;};
const fmtSize=n=>n>=1024**3?`${(n/1024**3).toFixed(2)} ГБ`:n>=1024**2?`${(n/1024**2).toFixed(1)} МБ`:n>=1024?`${(n/1024).toFixed(0)} КБ`:`${n} Б`;
const setMessage=(id,text,error=false)=>{const e=$(id);e.textContent=text;e.classList.toggle('error',!!error);};
const toolById=new Map(tools.filter(isBatchTool).map(t=>[t.id,t]));
for(const category of [...new Set([...toolById.values()].map(t=>t.category))]){
  const group=document.createElement('optgroup');group.label=category;
  for(const tool of toolById.values())if(tool.category===category){const option=document.createElement('option');option.value=tool.id;option.textContent=tool.title;group.append(option);}
  toolSelect.append(group);
}
const queryTool=new URL(location.href).searchParams.get('tool');
if(queryTool&&toolById.has(queryTool))toolSelect.value=queryTool;
function currentTool(){return toolById.get(toolSelect.value);}
function appendOption(def){
  const label=document.createElement('label');label.className='batch-field batch-option';label.textContent=def.label;
  let input;
  if(def.type==='select'){
    input=document.createElement('select');
    for(const [value,title] of def.choices){const o=document.createElement('option');o.value=value;o.textContent=title;input.append(o);}
  }else{
    input=document.createElement('input');input.type=def.type||'text';
    if(def.min!==undefined)input.min=def.min;
    if(def.max!==undefined)input.max=def.max;
    if(def.step!==undefined)input.step=def.step;
    if(input.type==='text')input.maxLength=80;
  }
  input.name=def.key;input.value=String(def.default??'');input.required=true;
  label.append(input);
  if(def.hint){const help=document.createElement('small');help.textContent=def.hint;label.append(help);}
  return label;
}
function updateFileHint(){
  const tool=currentTool(),size=tool?.requiredFiles||1;
  const files=Array.from(filesInput.files||[]);
  const count=files.length;
  fileHint.textContent=size===2?'Выбирайте файлы парами в нужном порядке: каждые два файла образуют одно задание.':'Для каждого файла будет создано отдельное задание.';
  if(!count){selectedFiles.textContent='Файлы пока не выбраны';return;}
  selectedFiles.textContent=`Выбрано ${count} ${wordForm(count,['файл','файла','файлов'])} (${fmtSize(files.reduce((sum,file)=>sum+file.size,0))}). ${size===2?'Пар: '+Math.floor(count/2)+'. ':''}`+
    files.map(f=>f.name).slice(0,4).join(' · ')+(count>4?' · …':'');
}
function showTool(){
  const tool=currentTool();if(!tool)return;
  $('batch-tool-hint').textContent=tool.description+(tool.requiredFiles===2?' · Добавляйте файлы парами.':'');
  filesInput.accept=tool.accept||'*/*';filesInput.value='';
  optionRoot.replaceChildren(...(tool.options||[]).map(appendOption));
  const saved=readPreset(tool);
  for(const def of tool.options||[]){
    const value=saved[def.key];const field=form.elements.namedItem(def.key);
    if(!field||value===undefined)continue;
    if(def.type==='select'&&!def.choices.some(([v])=>String(v)===value))continue;
    if(def.type==='number'&&(!Number.isFinite(Number(value))||(def.min!==undefined&&Number(value)<def.min)||(def.max!==undefined&&Number(value)>def.max)))continue;
    field.value=value;
  }
  updateFileHint();setMessage('batch-add-message','');
}
toolSelect.addEventListener('change',showTool);
filesInput.addEventListener('change',updateFileHint);
const dropzone=$('batch-dropzone');
dropzone.addEventListener('dragover',e=>{e.preventDefault();dropzone.classList.add('dragover');});
dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop',e=>{
  e.preventDefault();dropzone.classList.remove('dragover');
  const files=e.dataTransfer?.files;
  if(!files?.length)return;
  try{filesInput.files=files;updateFileHint();}
  catch{setMessage('batch-add-message','Выберите файлы кнопкой выше.',true);}
});

let painting=false;
const queue=new BatchQueue({
  execute:async(job,signal,progress)=>job.tool.run({files:job.files,values:job.values,signal,progress,stop:()=>{}}),
  onChange:()=>{
    for(const job of queue.jobs)if(job.startedAt!==null && !reported.has(job.id) && ['success','error','cancelled'].includes(job.status)){
      reported.add(job.id);recordOperation(job.tool.id,job.status,job.files,job.result,job.elapsedMs);
    }
    schedulePaint();
  }
});
function schedulePaint(){if(painting)return;painting=true;requestAnimationFrame(()=>{painting=false;render();});}
function safeDownload(blob,name){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function resultBlob(job){
  if(job.result?.blob instanceof Blob)return {blob:job.result.blob,name:job.result.name||`lokit-${job.id}.bin`};
  if(Array.isArray(job.result?.rows)){
    const obj=Object.fromEntries(job.result.rows.map(([key,value])=>[String(key),value]));
    return {blob:new Blob([JSON.stringify(obj,null,2)],{type:'application/json;charset=utf-8'}),name:`${job.files[0]?.name?.replace(/\.[^.]+$/,'')||'file'}-info.json`};
  }
  return null;
}
function makeJobNode(job){
  const card=document.createElement('article');card.className='batch-job';card.dataset.jobId=String(job.id);
  const top=document.createElement('div');top.className='batch-job-top';
  const title=document.createElement('div');title.className='batch-job-title';
  const badge=document.createElement('span');badge.className='batch-job-status';top.append(title,badge);
  const desc=document.createElement('div');desc.className='batch-job-desc';
  const progressWrap=document.createElement('div');progressWrap.className='batch-job-progress';
  const progress=document.createElement('progress');progress.max=100;progress.setAttribute('aria-label','Прогресс задания');
  const percentage=document.createElement('span');progressWrap.append(progress,percentage);
  const actions=document.createElement('div');actions.className='batch-job-actions';
  const save=document.createElement('button');save.type='button';save.className='secondary';save.textContent='Скачать';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='Отменить';
  save.addEventListener('click',()=>{const item=queue.jobs.find(j=>j.id===job.id);if(item?.status==='success'){
    const output=resultBlob(item);if(output)safeDownload(output.blob,output.name);
  }});
  cancel.addEventListener('click',()=>queue.cancel(job.id));
  actions.append(save,cancel);card.append(top,desc,progressWrap,actions);
  return {card,title,badge,desc,progress,percentage,save,cancel};
}
function render(){
  const snapshot=queue.snapshot();
  for(const id of [...jobNodes.keys()])if(!queue.jobs.some(x=>x.id===id)){jobNodes.get(id).card.remove();jobNodes.delete(id);}
  const statuses={pending:'В очереди',running:'Обрабатывается',success:'Готово',error:'Ошибка',cancelled:'Отменено'};
  for(const job of queue.jobs){
    let n=jobNodes.get(job.id);
    if(!n){n=makeJobNode(job);jobNodes.set(job.id,n);itemsRoot.append(n.card);}
    n.card.dataset.status=job.status;
    n.title.textContent=`${job.tool.title} · ${job.files.map(f=>f.name).join(' + ')}`;
    n.badge.textContent=job.abortPending?'Отмена…':statuses[job.status];
    n.desc.textContent=job.error||job.description;
    if(job.percent===null)n.progress.removeAttribute('value');else n.progress.value=job.percent;
    n.percentage.textContent=job.percent===null?'…':`${Math.floor(job.percent)}%`;
    n.save.classList.toggle('hidden',job.status!=='success');n.save.disabled=job.status!=='success';
    n.cancel.classList.toggle('hidden',job.status!=='pending'&&job.status!=='running');
    n.cancel.disabled=job.abortPending;
  }
  $('batch-empty').classList.toggle('hidden',snapshot.total>0);
  $('batch-counts').textContent=`Всего: ${snapshot.total} · Готово: ${snapshot.counts.success} · С ошибками: ${snapshot.counts.error} · Отменено: ${snapshot.counts.cancelled} · В очереди: ${snapshot.counts.pending}`;
  $('batch-overall').value=snapshot.percent;
  $('batch-overall-percent').textContent=`${snapshot.percent}%`;
  $('batch-progress-title').textContent=snapshot.paused?'Остановка после текущего задания':snapshot.running?'Обрабатываем файлы':'Общий прогресс';
  $('batch-start').disabled=exporting||snapshot.counts.pending===0;
  $('batch-start').textContent=snapshot.paused?'Продолжить обработку':snapshot.running?'Идёт обработка':'Запустить очередь';
  $('batch-pause').disabled=!snapshot.running||snapshot.paused;
  $('batch-cancel-all').disabled=(!snapshot.running&&!snapshot.counts.pending)||exporting;
  $('batch-retry').disabled=exporting||snapshot.running||!snapshot.counts.error&&!snapshot.counts.cancelled;
  $('batch-clear').disabled=exporting||!snapshot.counts.success&&!snapshot.counts.error&&!snapshot.counts.cancelled;
  const completed=queue.jobs.filter(j=>j.startedAt!==null&&['success','error','cancelled'].includes(j.status));
  const completedDuration=completed.reduce((n,j)=>n+j.elapsedMs,0);
  const started=queue.jobs.filter(j=>j.startedAt!==null);
  const running=queue.jobs.find(j=>j.status==='running');
  const elapsed=completedDuration+(running?Date.now()-running.startedAt:0);
  $('batch-elapsed').textContent=`Прошло: ${fmtMs(elapsed)}`;
  const remaining=snapshot.counts.pending+(running?1:0);
  $('batch-remaining').textContent=completed.length&&remaining?`Осталось ≈ ${fmtMs(completedDuration/completed.length*remaining)}`:remaining?'Осталось: считаем…':'Осталось: 00:00:00';
  $('batch-ready').textContent=snapshot.counts.success?`Готовые файлы: ${snapshot.counts.success}. Скачайте по одному или одним ZIP.`:'Пока нет готовых файлов';
  $('batch-zip').disabled=exporting||snapshot.running||!snapshot.counts.success;
  $('batch-zip-cancel').classList.toggle('hidden',!exporting);
}
form.addEventListener('submit',event=>{
  event.preventDefault();
  const tool=currentTool();
  if(!tool)return;
  const values={};
  for(const def of tool.options||[]){
    const field=form.elements.namedItem(def.key);
    if(!field?.checkValidity()){setMessage('batch-add-message',`Проверьте значение поля «${def.label}».`,true);return;}
    values[def.key]=field.value;
  }
  const files=Array.from(filesInput.files||[]);
  try{
    const groups=groupFiles(tool,files);
    if(tool.id==='video-trim' && Number(values.end)>0 && Number(values.start)>=Number(values.end))throw new Error('Конец фрагмента должен быть позже начала.');
    const jobs=queue.add(tool,files,values);
    savePreset(tool,form);
    filesInput.value='';updateFileHint();
    setMessage('batch-add-message',`Добавлено заданий: ${jobs.length}. ${groups.length===1?'':'Можно добавить задания другого инструмента.'}`);
    $('batch-queue-title').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(error){setMessage('batch-add-message',error?.message||'Не получилось добавить файлы в очередь.',true);}
});
$('batch-start').addEventListener('click',()=>{void queue.start();});
$('batch-pause').addEventListener('click',()=>queue.pause());
$('batch-cancel-all').addEventListener('click',()=>queue.cancelAll());
$('batch-retry').addEventListener('click',()=>queue.retryFailed());
$('batch-clear').addEventListener('click',()=>queue.clearFinished());
$('batch-zip').addEventListener('click',async()=>{
  if(exporting||queue.running)return;
  const ready=queue.jobs.filter(j=>j.status==='success').map(resultBlob).filter(Boolean);
  if(!ready.length)return;
  exporting=true;const controller=new AbortController();exportAbort=controller;
  $('batch-zip-progress').classList.remove('hidden');$('batch-zip-progress').value=0;
  setMessage('batch-export-status','Подготавливаем ZIP-архив…');render();
  try{
    const blob=await createZip(ready,{signal:controller.signal,onProgress:info=>{
      $('batch-zip-progress').value=info.percent;
      setMessage('batch-export-status',`Собираем ZIP: ${info.percent}% · ${fmtSize(info.bytes)} из ${fmtSize(info.totalBytes)}`);
    }});
    if(controller.signal.aborted)throw new DOMException('Отменено','AbortError');
    safeDownload(blob,`lokit-batch-${new Date().toISOString().slice(0,10)}.zip`);
    setMessage('batch-export-status',`ZIP готов. Файлов: ${ready.length}, размер: ${fmtSize(blob.size)}. Скачивание началось.`);
  }catch(error){setMessage('batch-export-status',error?.name==='AbortError'?'Сборка ZIP-архива отменена.':error?.message||'Не получилось собрать ZIP-архив.',error?.name!=='AbortError');}
  finally{exporting=false;exportAbort=null;$('batch-zip-progress').classList.add('hidden');render();}
});
$('batch-zip-cancel').addEventListener('click',()=>exportAbort?.abort());
window.addEventListener('beforeunload',event=>{
  if(queue.running||exporting){event.preventDefault();event.returnValue='';}
});
recordEvent('view');showTool();render();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{}));
