/** Bound PWA setup so a failed install cannot leave editor preparation waiting. */
export function ensureServiceWorker({serviceWorker=globalThis.navigator?.serviceWorker,signal,timeoutMs=15000}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(value);
    };
    const abort=()=>finish(new DOMException('Загрузка отменена','AbortError'));
    const timer=setTimeout(()=>finish(new Error('Не удалось подготовить автономный режим. Повторите попытку или откройте редактор без сохранения.')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    if(!serviceWorker){finish(new Error('Браузер не поддерживает автономный режим.'));return;}
    Promise.resolve().then(()=>serviceWorker.register('./sw.js')).then(registration=>{
      if(settled)return;
      return registration.active?registration:serviceWorker.ready;
    }).then(value=>finish(null,value),error=>finish(error));
  });
}
