import {supportedMediaFeatures} from './media.js';
import './version.js';
function showCapabilities(){
  const root=document.getElementById('capability-grid');if(!root)return;
  const data=supportedMediaFeatures();
  const support={
    'MediaRecorder':['Запись и экспорт видео',data.mediaRecorder&&data.canvasCapture,'Используется для создания видеофайлов и записи экрана'],
    'WebCodecs':['Ускоренное кодирование',data.webCodecs,'WebCodecs можно выбрать при конвертации и сжатии. При ошибке Lokit попробует обычный экспорт'],
    'Video Frame Callback':['Точный показ кадров',data.frameCallback,'Помогает точнее показывать кадры при воспроизведении'],
    'FFmpeg/WASM':['FFmpeg в браузере',typeof Worker!=='undefined' && typeof WebAssembly!=='undefined','Доступен по выбору для конвертации и сжатия. При первом включении загружается около 31 МБ; исходные файлы остаются на устройстве'],
    'OffscreenCanvas':['Фоновая обработка графики',data.offscreenCanvas,'Может использоваться для обработки изображений вне основного окна']
  };
  for(const [title,[label,ok,detail]] of Object.entries(support)){
    const card=document.createElement('div');card.className='capability-card';
    const name=document.createElement('strong');name.textContent=`${title} · ${ok?'поддерживается':'не поддерживается'}`;
    const description=document.createElement('span');description.textContent=`${label}. ${detail}.`;
    card.append(name,description);root.append(card);
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',showCapabilities,{once:true});
else showCapabilities();
