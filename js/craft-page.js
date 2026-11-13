import {prepareCraftAssets} from './craft-loader.js';
import {applyNativeRussian,russianAppURL,russianCatalogStatus,setRussianStoredPreference,supportsNativeLanguageCommand} from './craft-language.js';

const $=selector=>document.querySelector(selector);
const loader=$('#craft-loader');
const title=$('#craft-title');
const detail=$('#craft-progress-detail');
const progressTitle=$('#craft-progress-title');
const progressBar=$('#craft-progress-bar');
const percent=$('#craft-progress-percent');
const bytes=$('#craft-progress-bytes');
const files=$('#craft-progress-files');
const frame=$('#craft-frame');
const openNow=$('#craft-open-now');
const retry=$('#craft-retry');
const status=$('#craft-status');
const language=$('#craft-language');
let abort=null,launched=false,attempt=0;

function formatBytes(value){
  if(!Number.isFinite(value))return '—';
  if(value<1024)return value+' Б';
  if(value<1024*1024)return (value/1024).toFixed(1)+' КБ';
  return (value/1024/1024).toFixed(1)+' МБ';
}
function setError(message){
  progressTitle.textContent='Не удалось подготовить автономную копию';
  detail.textContent=message;
  bytes.textContent='Можно повторить загрузку или открыть редактор без сохранения';
  status.textContent=message;
  retry.hidden=false;
}
function updateProgress(info){
  const value=Math.max(0,Math.min(100,info.percent));
  progressBar.value=value;
  percent.textContent=value+'%';
  bytes.textContent=formatBytes(info.loaded)+' из '+formatBytes(info.total);
  files.textContent='Файлов: '+info.done+' из '+info.count+
    (info.reused?' · из кэша: '+info.reused:'')+
    (info.file?' · '+info.file:'');
  progressTitle.textContent=info.stage==='complete'?'Файлы подготовлены':'Загрузка '+title.textContent;
  detail.textContent=info.stage==='cached'
    ?'Используются уже сохранённые ресурсы'
    :info.stage==='complete'
      ?'Подготовка завершена, запускается интерфейс…'
      :'Загрузка и сохранение файлов движка. Уже загруженные ресурсы останутся в браузере.';
}

async function main(){
  const name=new URL(location.href).searchParams.get('app')||'';
  const registryURL=new URL('./artcraft-releases.json',document.baseURI);
  let registry;
  try{
    const response=await fetch(registryURL,{cache:'no-store'});
    if(!response.ok)throw new Error('HTTP '+response.status);
    registry=await response.json();
  }catch(error){
    setError('Каталог приложений недоступен: '+error.message);
    openNow.disabled=true;retry.hidden=true;
    return;
  }
  const entry=registry.apps?.find(item=>item.name===name);
  if(!entry||!/^[a-z0-9-]+$/.test(name)){
    title.textContent='Неизвестный редактор';
    setError('Выберите приложение в каталоге Lokit.');
    openNow.disabled=true;retry.hidden=true;
    return;
  }
  title.textContent=entry.title;
  document.title=entry.title+' — Lokit';
  $('#craft-version').textContent='ArtCraft v'+entry.version+' · веб-версия';
  $('#craft-source').href='https://github.com/storytold/'+name;
  const root=new URL('./craft-apps/'+name+'/',document.baseURI);
  const russian=russianCatalogStatus(name);
  if(russian==='missing'){
    language.textContent='Русский перевод отсутствует в оригинальной версии этого редактора.';
    language.dataset.available='false';
  }else{
    language.textContent='Русский интерфейс: подготовка настроек…';
    language.dataset.available='true';
    setRussianStoredPreference(name,window.localStorage);
  }
  $('#craft-direct').href=russianAppURL(root.href,name);

  function launch(){
    if(launched)return;
    launched=true;
    abort?.abort();
    progressTitle.textContent='Запуск приложения';
    detail.textContent='Сайт загрузился, теперь запускается интерфейс и WebAssembly-движок…';
    files.textContent='При первом запуске инициализация может занять некоторое время.';
    bytes.textContent='Ожидание интерфейса';
    progressBar.removeAttribute('value');
    percent.textContent='…';
    retry.hidden=true;
    openNow.disabled=true;
    frame.addEventListener('load',()=>{
      try{
        const doc=frame.contentDocument;
        if(doc?.title==='Error response'||doc?.title?.includes('404')){
          setError('Сервер не смог открыть веб-версию. Проверьте публикацию GitHub Pages.');
          launched=false;openNow.disabled=false;return;
        }
      }catch{/* The iframe might have its own policies. */}
      frame.hidden=false;
      loader.hidden=true;
      status.textContent=entry.title+' открыт. Инициализация WASM может продолжаться.';
      if(russian==='available'){
        // The controls are installed by the WASM app after the iframe's load.
        // A successful response confirms the switch; a missing endpoint does not.
        void applyNativeRussian(frame.contentWindow,name).then(applied=>{
          if(applied){
            language.textContent='Русский язык интерфейса включён.';
            status.textContent=entry.title+' открыт. Русский язык включён.';
          }else if(supportsNativeLanguageCommand(name)){
            language.textContent='Русский язык запрошен. При необходимости выберите «Русский» в настройках редактора.';
          }else{
            language.textContent='Русский язык выбран, если он поддерживается этой веб-сборкой. При необходимости переключите его в настройках.';
          }
        }).catch(()=>{
          language.textContent='Русский язык можно выбрать в настройках редактора.';
        });
      }
    },{once:true});
    frame.src=russianAppURL(root.href,name);
  }
  openNow.addEventListener('click',launch);
  async function prepare(){
    if(launched)return;
    retry.hidden=true;
    abort?.abort();
    abort=new AbortController();
    const run=++attempt;
    try{
      if('serviceWorker' in navigator) {
        await navigator.serviceWorker.register('./sw.js');
        await navigator.serviceWorker.ready;
      }else throw new Error('Браузер не поддерживает Service Worker.');
      if(run!==attempt||launched)return;
      await prepareCraftAssets({
        baseURL:root.href,
        app:entry.name,version:entry.version,
        cacheStorage:caches,signal:abort.signal,
        storageManager:navigator.storage,
        onProgress:updateProgress
      });
      if(run===attempt&&!launched)launch();
    }catch(error){
      if(run!==attempt||launched)return;
      setError(error.message||String(error));
    }
  }
  retry.addEventListener('click',prepare);
  await prepare();
}
main();
