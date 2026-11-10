import {supportedMediaFeatures} from './media.js';
import './version.js';
function showCapabilities(){
  const root=document.getElementById('capability-grid');if(!root)return;
  const data=supportedMediaFeatures();
  const support={
    'MediaRecorder':['Кодирование WebM/MP4',data.mediaRecorder&&data.canvasCapture,'Нужен для создания видео и записи'],
    'WebCodecs':['Низкоуровневые кодеки',data.webCodecs,'Экспериментальный WebCodecs доступен в конвертере и сжатии по отдельному выбору; при ошибке применяется обычный экспорт'],
    'Video Frame Callback':['Синхронизация кадров',data.frameCallback,'Улучшает плавность предпросмотра и своевременность обработки'],
    'FFmpeg/WASM':['Однопоточный FFmpeg',typeof Worker!=='undefined' && typeof WebAssembly!=='undefined','Опционально в конвертере и сжатии: первое включение загружает около 31 МБ, без передачи исходных файлов'],
    'OffscreenCanvas':['Внеэкранный Canvas',data.offscreenCanvas,'Резерв для фоновых вычислений']
  };
  for(const [title,[label,ok,detail]] of Object.entries(support)){
    const card=document.createElement('div');card.className='capability-card';
    const name=document.createElement('strong');name.textContent=`${title} · ${ok?'доступен':'недоступен'}`;
    const description=document.createElement('span');description.textContent=`${label}. ${detail}.`;
    card.append(name,description);root.append(card);
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',showCapabilities,{once:true});
else showCapabilities();
