import {CODEC_NAMES, downloadAllCodecs, getCodecManifest, getCodecStatus, removeOfflineCodecs} from './codec-assets.js';
const $ = id => document.getElementById(id);
const label = {mediabunny:'Mediabunny', ffmpegCore:'FFmpeg (JavaScript)', ffmpegWasm:'FFmpeg (WebAssembly)'};
const status = $('offline-codecs-status');
const progress = $('offline-codecs-progress');
const download = $('offline-codecs-download');
const remove = $('offline-codecs-remove');
const size = $('offline-codecs-size');
let active = false;
function formatBytes(num) {return (num/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МиБ';}
async function refresh(message = '') {
  const data = await getCodecStatus();
  status.textContent = message || (data.supported
    ? data.complete ? 'Все три модуля сохранены на этом устройстве и доступны офлайн.'
      : 'Сохранено ' + data.cached.length + ' из ' + CODEC_NAMES.length + ': ' + (data.cached.map(x=>label[x]).join(', ')||'пока ничего') + '.'
    : 'Браузер не поддерживает сохранение модулей для работы офлайн.');
  download.disabled = active || !data.supported || data.complete;
  remove.disabled = active || !data.supported || data.cached.length === 0;
}
const manifest = await getCodecManifest();
if (manifest?.files?.length) {
  const bytes = manifest.files.reduce((sum,item)=>sum+(Number(item.bytes)||0),0);
  size.textContent = 'Объём полной загрузки: ' + formatBytes(bytes) + '.';
} else size.textContent = 'Полный комплект — около 35 МиБ; точный размер станет доступен после публикации модулей.';
download.addEventListener('click',async()=>{
  if(active)return;
  active=true;await refresh();
  progress.hidden=false;progress.max=CODEC_NAMES.length;progress.value=0;
  status.textContent='Скачивание модулей с сайта Lokit…';
  let errorMessage = '';
  try{
    await downloadAllCodecs({onProgress:state=>{
      progress.value=state.completed;
      status.textContent='Сохранение: ' + label[state.name] + ' (' + state.completed + '/' + state.total + ')';
    }});
    status.textContent='Все модули доступны офлайн.';
  }catch(error){errorMessage='Ошибка: '+error.message;}
  finally{active=false;await refresh(errorMessage);}
});
remove.addEventListener('click',async()=>{
  if(active)return;
  active=true;await refresh();
  let errorMessage = '';
  try{await removeOfflineCodecs();progress.hidden=true;}
  catch(error){errorMessage='Ошибка очистки: '+error.message;}
  finally{active=false;await refresh(errorMessage);}
});
refresh().catch(error=>{status.textContent=error.message;});

// Opening the settings page alone should also make the app shell available offline.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(()=>{});
