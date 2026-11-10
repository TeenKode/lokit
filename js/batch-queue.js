/** A single-threaded, browser-local queue shared by all file-based tools.
 * Every job snapshots its files/parameters. No files or outputs are persisted.
 */
export const MAX_BATCH_JOBS=100;
const FINISHED=new Set(['success','error','cancelled']);
const abortError=()=>new DOMException('Операция отменена','AbortError');
export function isBatchTool(tool){return !!tool&&!tool.isCapture&&typeof tool.run==='function';}
export function groupFiles(tool,files){
  if(!isBatchTool(tool))throw new Error('Запись экрана и камеры недоступна в пакетном режиме.');
  const size=Number(tool.requiredFiles||1);
  if(!Number.isSafeInteger(size)||size<1||size>2)throw new Error('Неподдерживаемое число входных файлов.');
  const all=Array.from(files||[]);
  if(!all.length)throw new Error('Сначала выберите файлы.');
  if(all.length%size!==0)throw new Error(`Для «${tool.title}» файлы нужно выбирать группами по ${size}. Сейчас выбрано: ${all.length}.`);
  return Array.from({length:all.length/size},(_,index)=>all.slice(index*size,(index+1)*size));
}
let nextJobId=0;
export class BatchQueue {
  constructor({execute,onChange=()=>{},now=()=>Date.now(),maxJobs=MAX_BATCH_JOBS}={}){
    if(typeof execute!=='function')throw new TypeError('Ожидается обработчик execute.');
    this.execute=execute;this.onChange=onChange;this.now=now;this.maxJobs=maxJobs;
    this.jobs=[];this.active=null;this.paused=false;this.running=false;this._loop=null;
  }
  notify(){this.onChange(this.snapshot());}
  snapshot(){
    const counts={pending:0,running:0,success:0,error:0,cancelled:0};
    let units=0;
    for(const job of this.jobs){counts[job.status]++;units+=FINISHED.has(job.status)?1:job.status==='running'?(job.percent===null?0:job.percent/100):0;}
    const total=this.jobs.length;
    return {total,counts,percent:total?Math.round(units/total*100):0,paused:this.paused,running:this.running,activeId:this.active?.id||null};
  }
  add(tool,files,values={}){
    const batches=groupFiles(tool,files);
    if(this.jobs.length+batches.length>this.maxJobs)throw new Error(`В очереди может быть не более ${this.maxJobs} заданий. Очистите завершённые.`);
    const created=batches.map(group=>({id:++nextJobId,tool,files:[...group],values:{...values},status:'pending',percent:0,description:'Ожидание',startedAt:null,endedAt:null,elapsedMs:0,result:null,error:'',abortPending:false}));
    this.jobs.push(...created);this.notify();return created;
  }
  async start(){
    this.paused=false;
    if(this._loop){this.notify();return this._loop;}
    this._loop=this._drain();
    try{return await this._loop;}finally{this._loop=null;this.notify();}
  }
  pause(){this.paused=true;this.notify();}
  cancel(id){
    const job=this.jobs.find(x=>x.id===id);
    if(!job||FINISHED.has(job.status))return false;
    if(job.status==='pending'){
      job.status='cancelled';job.percent=100;job.description='Отменено';job.endedAt=this.now();
    }else if(job.status==='running'){
      job.abortPending=true;job.description='Отмена…';
      if(this.active?.id===id)this.active.controller.abort();
    }
    this.notify();return true;
  }
  cancelAll(){
    this.paused=true;
    for(const job of this.jobs)if(!FINISHED.has(job.status))this.cancel(job.id);
    this.notify();
  }
  retryFailed(){
    let count=0;
    for(const job of this.jobs)if(job.status==='error'||job.status==='cancelled'){
      Object.assign(job,{status:'pending',percent:0,description:'Ожидание',startedAt:null,endedAt:null,elapsedMs:0,result:null,error:'',abortPending:false});count++;
    }
    if(count)this.notify();return count;
  }
  clearFinished(){
    const before=this.jobs.length;
    this.jobs=this.jobs.filter(j=>!FINISHED.has(j.status));
    if(before!==this.jobs.length)this.notify();
  }
  async _drain(){
    this.running=true;this.notify();
    try{
      while(!this.paused){
        const job=this.jobs.find(x=>x.status==='pending');
        if(!job)break;
        const controller=new AbortController();this.active={id:job.id,controller};
        job.status='running';job.percent=null;job.description='Подготовка…';job.startedAt=this.now();job.abortPending=false;this.notify();
        try{
          const result=await this.execute(job,controller.signal,info=>{
            if(job.status!=='running'||job.abortPending)return;
            const data=typeof info==='number'?{percent:info}:info||{};
            if(Number.isFinite(data.percent)&&data.percent!==null){job.percent=Math.max(job.percent||0,Math.min(99,Math.max(0,Number(data.percent))));}
            if(typeof data.description==='string')job.description=data.description.slice(0,150);
            else if(data.stage==='finalizing')job.description='Завершение…';
            else if(data.stage==='processing')job.description='Обработка…';
            this.notify();
          });
          if(controller.signal.aborted||job.abortPending)throw abortError();
          if(!result || !(result.blob instanceof Blob) && !Array.isArray(result.rows))throw new Error('Инструмент не создал результат.');
          job.result=result;job.status='success';job.description='Готово';job.percent=100;
        }catch(error){
          job.result=null;job.percent=100;
          if(controller.signal.aborted||job.abortPending||error?.name==='AbortError'){
            job.status='cancelled';job.description='Отменено';
          }else{
            job.status='error';job.error=String(error?.message||error||'Ошибка обработки').slice(0,500);job.description='Ошибка';
          }
        }finally{
          job.endedAt=this.now();job.elapsedMs=Math.max(0,job.endedAt-job.startedAt);
          this.active=null;this.notify();
        }
      }
    }finally{this.running=false;this.active=null;this.notify();}
  }
}
