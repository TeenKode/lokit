import {supportedMediaFeatures} from './media.js';
import './version.js';
function showCapabilities(){
  const root=document.getElementById('capability-grid');if(!root)return;
  const data=supportedMediaFeatures();
  const support={
    'MediaRecorder':['Кодирование WebM/MP4',data.mediaRecorder&&data.canvasCapture,'Нужен для создания видео и записи'],
    'WebCodecs':['Низкоуровневые кодеки',data.webCodecs,'Аппаратный WebCodecs-экспорт сложных эффектов пока не включён; MP4/WebM без перекодирования обрабатываются отдельным контейнерным движком'],
    'Video Frame Callback':['Синхронизация кадров',data.frameCallback,'Улучшает плавность предпросмотра и своевременность обработки'],
    'OffscreenCanvas':['Внеэкранный Canvas',data.offscreenCanvas,'Резерв для будущих фоновых вычислений']
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
