// Lokit hosts the original PdfCraft web release on the same origin.
import {savePdfCraftOffline,PDFCRAFT_OFFLINE_CACHE} from './pdf-offline.js';
import {applyNativeRussian,russianAppURL} from './craft-language.js';

const root=new URL('./pdfcraft/',document.baseURI);
const status=document.querySelector('#pdf-status');
const loading=document.querySelector('#pdf-loading');
const frame=document.querySelector('#pdf-frame');
const offlineButton=document.querySelector('#offline-pdf');
function report(message){status.textContent=message;}

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{
    report('Автономная работа недоступна: не удалось зарегистрировать PWA.');
  });
}
async function start(){
  try{
    const response=await fetch(new URL('index.html',root),{cache:'no-store'});
    if(!response.ok||!(await response.text()).includes('id="pdfcraft"'))
      throw new Error('Статическая сборка PDFCraft ещё не опубликована.');
    frame.addEventListener('load',()=>{
      loading.hidden=true;frame.hidden=false;
      void applyNativeRussian(frame.contentWindow,'pdfcraft').then(applied=>{
        if(applied)report('Русский язык PDFCraft включён. Документы обрабатываются локально.');
      });
    },{once:true});
    frame.src=russianAppURL(root.href,'pdfcraft');
    document.querySelector('#pdf-full').href=russianAppURL(root.href,'pdfcraft');
    offlineButton.disabled=!('caches' in window)||!('serviceWorker' in navigator);
    report('Редактор загружен локально. Файлы обрабатываются на устройстве.');
  }catch(error){
    loading.textContent='PDF-движок недоступен. Сборка PDFCraft добавляется при публикации через GitHub Actions. '+error.message;
    report('Не удалось открыть PDF-редактор.');
  }
}
offlineButton.addEventListener('click',async()=>{
  offlineButton.disabled=true;
  const label=offlineButton.textContent;
  offlineButton.textContent='Сохранение…';
  try{
    if(!('caches' in window)||!('serviceWorker' in navigator))
      throw new Error('Браузер не поддерживает автономное хранение.');
    const registration=await navigator.serviceWorker.getRegistration('./');
    if(!registration)throw new Error('Service Worker не зарегистрирован.');
    await registration.update();
    await navigator.serviceWorker.ready;
    await savePdfCraftOffline({
      baseURL:root.href,
      cacheStorage:caches,
      cacheName:PDFCRAFT_OFFLINE_CACHE,
      storageManager:navigator.storage,
      progress:({done,total,file})=>{
        report('Сохранение PDFCraft и OCR: '+done+' из '+total+' · '+file);
      }
    });
    report('PDFCraft и модели OCR сохранены для работы без интернета.');
  }catch(error){
    report('Не удалось полностью сохранить офлайн-версию: '+error.message+'. Уже загруженные файлы сохранены. Повторите попытку.');
  }finally{
    offlineButton.disabled=false;
    offlineButton.textContent=label;
  }
});
start();
