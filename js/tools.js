import { transformVideo,frameFromVideo,inspectVideo,extractAudio,recordDevice,outputName } from './media.js';

const width = {
  key:'resolution',label:'Разрешение итогового видео',type:'select',
  choices:[
    ['original','Как у исходного видео (без уменьшения)'],
    ['360','360p — компактный файл'],['480','480p — стандартное'],
    ['720','720p — HD'],['1080','1080p — Full HD'],['2160','2160p — 4K']
  ],default:'original',
  hint:'Например, 1920×1080 → 1280×720 при 720p; вертикальное 1080×1920 → 720×1280. Пропорции сохраняются, качество вверх не увеличивается.'
};
const fps = {key:'fps',label:'Частота кадров',type:'select',choices:[['15','15 FPS'],['25','25 FPS'],['30','30 FPS']],default:'25'};
const asTime=(seconds)=>{const s=Math.max(0,Math.floor(seconds));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const videoAccept='video/*,.mkv,.mov,.webm,.mp4';
const tool = (id,title,desc,icon,mode,options=[],category='Видео',extra={})=>({id,title,description:desc,icon,category,accept:videoAccept,options:[...options],async run({files,values,progress,signal}){
  const result=await transformVideo({files,mode,options:values,onProgress:progress,signal});
  return {blob:result.blob,name:outputName(files[0],id,result.ext),fast:!!result.fast,method:result.method,info:result.info};
},...extra});

export const tools=[
  tool('video-trim','Обрезка видео','Оставить нужный отрезок ролика','✂','trim',[
    {key:'start',label:'Начало, сек.',type:'number',default:'0',min:0,step:.01},
    {key:'end',label:'Конец, сек. (0 — до конца)',type:'number',default:'0',min:0,step:.01},
    {key:'cutMode',label:'Точность обрезки',type:'select',choices:[['exact','Точно по маркерам (рекомендуется)'],['keyframe','Быстро по ключевым кадрам (может начаться раньше)']],default:'exact'},width], 'Видео', {note:'MP4 обрезается быстро и без перекодирования; WebM — без перекодирования у ключевых кадров. Если нужна точная обрезка WebM между ключевыми кадрами, используется обычная обработка.'}),
  tool('mute-video','Удалить звук','Быстро убрать аудиодорожку MP4 без перекодирования','◌','mute',[width], 'Видео', {note:'Для MP4 при исходном разрешении звук удаляется без изменения видеокадров. Для других форматов доступен обычный экспорт.'}),
  tool('video-crop','Кадрирование видео','Убрать одинаковые поля по краям кадра','▣','crop',[
    {key:'crop',label:'Обрезать с каждого края, %',type:'number',default:'10',min:0,max:40,step:1},width]),
  tool('video-flip','Отразить видео','Зеркальное отражение по горизонтали или вертикали','⇆','flip-h',[width], 'Видео', {
    async run({files,values,progress,signal}){const mode=values.axis==='vertical'?'flip-v':'flip-h';const {blob,ext}=await transformVideo({files,mode,options:values,onProgress:progress,signal});return {blob,name:outputName(files[0],'flip',ext)};},
    options:[{key:'axis',label:'Направление',type:'select',choices:[['horizontal','Горизонтально'],['vertical','Вертикально']],default:'horizontal'},width]
  }),
  tool('video-rotate','Поворот видео','Повернуть кадры на 90, 180 или 270 градусов','↻','rotate-90',[width],'Видео',{
    options:[{key:'degrees',label:'Угол',type:'select',choices:[['90','90°'],['180','180°'],['270','270°']],default:'90'},width],
    async run({files,values,progress,signal}){const {blob,ext}=await transformVideo({files,mode:`rotate-${values.degrees}`,options:values,onProgress:progress,signal});return {blob,name:outputName(files[0],'rotate',ext)};}
  }),
  tool('video-speed','Скорость видео','Замедлить или ускорить воспроизведение','⏩','speed',[
    {key:'speed',label:'Скорость',type:'select',choices:[['0.5','0,5×'],['0.75','0,75×'],['1.25','1,25×'],['1.5','1,5×'],['2','2×']],default:'1.5'},width], 'Видео', {note:'Для MP4 без звука скорость меняется быстро, без перекодирования. Если есть аудио, используется обычный экспорт с обработкой звука.'}),
  tool('video-loop','Повтор видео','Записать ролик с заданным числом повторений','⟳','loop',[
    {key:'loops',label:'Количество повторений',type:'number',default:'2',min:1,max:10,step:1},width]),
  tool('video-filter','Цветовой фильтр','Оттенки серого, сепия, контраст, яркость','◐','filter',[
    {key:'filter',label:'Эффект',type:'select',choices:[['grayscale(1)','Чёрно-белый'],['sepia(1)','Сепия'],['contrast(1.4)','Контраст +40%'],['brightness(1.3)','Яркость +30%'],['saturate(1.6)','Насыщенность +60%'],['invert(1)','Негатив']],default:'grayscale(1)'},width]),
  tool('video-blur','Размытие видео','Размыть изображение целиком','◍','blur',[
    {key:'blur',label:'Степень размытия',type:'number',default:'5',min:0,max:35,step:1},width]),
  tool('video-watermark','Текст поверх видео','Нанести подпись в правом нижнем углу','T','watermark',[
    {key:'text',label:'Текст',type:'text',default:'Моё видео'},width]),
  tool('video-converter','Конвертер видео','Перекодировать в формат, доступный браузеру','⇄','convert',[width,fps]),
  tool('video-compressor','Сжатие видео','Уменьшить разрешение и битрейт видеопотока','▤','compress',[
    {key:'bitrate',label:'Битрейт видео',type:'select',choices:[['300000','300 кбит/с'],['650000','650 кбит/с'],['1000000','1 Мбит/с'],['1800000','1,8 Мбит/с']],default:'650000'},width]),
  tool('video-volume','Громкость видео','Увеличить или уменьшить громкость звука','♫','volume',[
    {key:'gain',label:'Уровень звука',type:'select',choices:[['0.25','25%'],['0.5','50%'],['1','100%'],['1.5','150%'],['2','200%']],default:'1'},width]),
  tool('video-merge','Склеить видео','Соединить два ролика последовательно','⊕','merge',[width], 'Видео',{maxFiles:2,requiredFiles:2,note:'MP4 одинакового формата и разрешения могут склеиваться мгновенно без перекодирования. Для несовместимых роликов используется обычный экспорт WebM.'}),
  tool('split-screen','Разделённый экран','Показать два видео рядом','◫','split',[width],'Видео',{maxFiles:2,requiredFiles:2,note:'Аудио берётся из первого ролика. Ролики запускаются одновременно.'}),
  tool('video-to-vr','Видео рядом с копией','Сделать стереопару для просмотра рядом','▥','vr',[width], 'Видео'),
  {
    id:'video-frames',title:'Кадр из видео',description:'Сохранить выбранный момент как PNG',icon:'▧',category:'Изображения',accept:videoAccept,
    options:[{key:'seconds',label:'Время кадра, сек.',type:'number',default:'0',min:0,step:.1}],
    async run({files,values,signal}){const {blob}=await frameFromVideo(files[0],values.seconds,signal);return {blob,name:outputName(files[0],'frame','png')};}
  },
  {
    id:'video-metadata',title:'Информация о видео',description:'Размер, длительность и разрешение файла',icon:'ⓘ',category:'Анализ',accept:videoAccept,
    options:[],async run({files,signal}){
      const data=await inspectVideo(files[0],signal);
      return {rows:[['Имя',data.name],['Тип файла',data.type],['Размер',`${(data.size/1024/1024).toFixed(2)} МБ`],['Разрешение',`${data.width} × ${data.height}`],['Длительность',`${asTime(data.duration)} (${data.duration.toFixed(2)} сек.)`],['Изменён',new Date(data.modified).toLocaleString('ru-RU')]]};
    }
  },
  {
    id:'video-to-audio',title:'Извлечь звук',description:'Сохранить звуковую дорожку отдельно',icon:'♪',category:'Аудио',accept:videoAccept,options:[],
    async run({files,progress,signal}){const {blob,ext}=await extractAudio(files[0],{onProgress:progress,signal});return {blob,name:outputName(files[0],'audio',ext)};}
  },
  {
    id:'screen-recorder',title:'Запись экрана',description:'Сохранить изображение экрана или вкладки',icon:'▣',category:'Запись',isCapture:true,options:[],
    async run({stop,signal,progress}){const {blob,ext}=await recordDevice('screen',{onStop:stop,onProgress:progress,signal});return {blob,name:`screen-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`};}
  },
  {
    id:'webcam-recorder',title:'Запись камеры',description:'Сохранить видео с камеры и микрофона',icon:'◎',category:'Запись',isCapture:true,options:[],
    async run({stop,signal,progress}){const {blob,ext}=await recordDevice('webcam',{onStop:stop,onProgress:progress,signal});return {blob,name:`webcam-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`};}
  },
  {
    id:'subtitle-converter',title:'SRT ⇄ VTT',description:'Конвертация форматов субтитров',icon:'≡',category:'Субтитры',accept:'.srt,.vtt,text/plain',options:[],
    async run({files}){const f=files[0];const source=await f.text();const isVtt=/^\uFEFF?WEBVTT\b/i.test(source.trimStart())||/\.vtt$/i.test(f.name);
      let result,ext;
      if(isVtt){result=vttToSrt(source);ext='srt';}else{result=srtToVtt(source);ext='vtt';}
      return {blob:new Blob([result],{type:'text/plain;charset=utf-8'}),name:outputName(f,'converted',ext)};
    }
  },
  {
    id:'subtitle-shift',title:'Сдвиг субтитров',description:'Изменить время всех реплик в SRT',icon:'⏱',category:'Субтитры',accept:'.srt,text/plain',options:[{key:'seconds',label:'Сдвиг, секунд (можно отрицательный)',type:'number',default:'2',step:.1}],
    async run({files,values}){const source=await files[0].text();const result=shiftSubtitle(source,Number(values.seconds)||0);return {blob:new Blob([result],{type:'text/plain;charset=utf-8'}),name:outputName(files[0],'shift','srt')};}
  },
  {
    id:'subtitle-merger',title:'Объединить субтитры',description:'Объединить две дорожки SRT в одну по времени',icon:'☷',category:'Субтитры',accept:'.srt,text/plain',maxFiles:2,requiredFiles:2,options:[],
    async run({files}){const merged=mergeSrt(await files[0].text(),await files[1].text());return {blob:new Blob([merged],{type:'text/plain;charset=utf-8'}),name:'merged-subtitles.srt'};}
  }
];

const parseStamp=str=>{
  const found=String(str).trim().match(/^(\d{1,2}):(\d\d):(\d\d)[,.](\d{3})$/);
  if(!found)return null;
  return (Number(found[1])*3600+Number(found[2])*60+Number(found[3]))*1000+Number(found[4]);
};
const stamp=(ms,sep=',')=>{
  ms=Math.max(0,Math.round(ms));
  const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60,rest=ms%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${sep}${String(rest).padStart(3,'0')}`;
};
function srtToVtt(text){
  const lines=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/^(\d\d:\d\d:\d\d),(\d{3})\s+-->\s+(\d\d:\d\d:\d\d),(\d{3})/,'$1.$2 --> $3.$4'));
  return 'WEBVTT\n\n'+lines.join('\n').trim()+'\n';
}
function vttToSrt(text){
  const blocks=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/^WEBVTT[^\n]*\n/i,'').trim().split(/\n\s*\n/);
  let i=0;
  return blocks.map(block=>{
    const lines=block.split('\n');const timeIndex=lines.findIndex(line=>line.includes('-->'));
    if(timeIndex<0)return null;
    const t=lines[timeIndex].match(/((?:\d{2}:)?\d{2}:\d{2})[.,](\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2})[.,](\d{3})/);
    if(!t)return null;
    const fullTime=time=>time.split(':').length===2?`00:${time}`:time;
    return `${++i}\n${fullTime(t[1])},${t[2]} --> ${fullTime(t[3])},${t[4]}\n${lines.slice(timeIndex+1).join('\n')}`;
  }).filter(Boolean).join('\n\n')+'\n';
}
function parseSrt(source){
  return source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n\s*\n/).map(block=>{
    const lines=block.split('\n');const pos=lines.findIndex(l=>l.includes('-->'));
    if(pos<0)return null;
    const match=lines[pos].match(/(\d{1,2}:\d\d:\d\d[,.]\d{3})\s+-->\s+(\d{1,2}:\d\d:\d\d[,.]\d{3})/);
    if(!match)return null;
    return {start:parseStamp(match[1]),end:parseStamp(match[2]),text:lines.slice(pos+1).join('\n')};
  }).filter(c=>c&&c.start!==null&&c.end!==null);
}
function serializeSrt(cues){return cues.map((cue,i)=>`${i+1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n')+'\n';}
function shiftSubtitle(text,seconds){
  const cues=parseSrt(text);
  if(!cues.length)throw new Error('Не найдены корректные временные метки SRT.');
  const delta=Math.round(seconds*1000);
  const shifted=cues.filter(cue=>cue.end+delta>0).map(cue=>({...cue,start:Math.max(0,cue.start+delta),end:Math.max(0,cue.end+delta)}));
  return serializeSrt(shifted);
}
function mergeSrt(a,b){
  const cues=[...parseSrt(a),...parseSrt(b)].sort((x,y)=>x.start-y.start);
  if(!cues.length)throw new Error('Не найдены корректные временные метки SRT.');
  return serializeSrt(cues);
}
