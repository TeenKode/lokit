import { transformVideo,frameFromVideo,inspectVideo,extractAudio,recordDevice,outputName } from './media.js';

const width = {
  key:'resolution',label:'Разрешение результата',type:'select',
  choices:[
    ['original','Как у исходного видео (без изменений)'],
    ['360','360p — минимальный размер'],['480','480p — небольшое видео'],
    ['720','720p — HD'],['1080','1080p — Full HD'],['2160','2160p — 4K']
  ],default:'original',
  hint:'Например, 1920×1080 → 1280×720 при выборе 720p. Пропорции сохраняются; повышение разрешения не улучшает качество.'
};
const engine={key:'engine',label:'Способ обработки',type:'select',choices:[['auto','Автоматически — быстрый доступный способ (рекомендуется)'],['classic','Встроенный кодировщик браузера — офлайн'],['webcodecs','WebCodecs — ускоренный экспорт при поддержке'],['ffmpeg','FFmpeg/WASM — резервный программный MP4 (медленнее)']],default:'auto',hint:'MP4/MOV/WebM обрабатываются без перекодирования, когда это возможно. Для MKV/AVI/WMV/TS и неподдерживаемых кодеков автоматически предлагается локальный FFmpeg/WASM (до 90 МиБ, при первом запуске нужна загрузка библиотеки). Файлы не отправляются на сервер.'};
const fps = {key:'fps',label:'Частота кадров',type:'select',choices:[['original','Исходная при копировании, иначе 30 FPS'],['15','15 FPS'],['25','25 FPS'],['30','30 FPS']],default:'original'};
const asTime=(seconds)=>{const s=Math.max(0,Math.floor(seconds));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const videoAccept='video/*,.mp4,.m4v,.mov,.3gp,.3g2,.webm,.mkv,.avi,.wmv,.flv,.mpeg,.mpg,.ts,.mts,.m2ts,.ogv';
const tool = (id,title,desc,icon,mode,options=[],category='Видео',extra={})=>({id,title,description:desc,icon,category,accept:videoAccept,options:[...options],async run({files,values,progress,signal}){
  const result=await transformVideo({files,mode,options:values,onProgress:progress,signal});
  return {blob:result.blob,name:outputName(files[0],id,result.ext),fast:!!result.fast,method:result.method,info:result.info};
},...extra});

export const tools=[
  {id:'artcraft-photocraft',title:"PhotoCraft",description:"Редактор фотографий, слои, маски и ретушь",icon:"▧",category:"Изображения",href:'./craft.html?app=photocraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-vectorcraft',title:"VectorCraft",description:"Векторная графика, SVG и кривые",icon:"◇",category:"Дизайн",href:'./craft.html?app=vectorcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-filmcraft',title:"FilmCraft",description:"Многодорожечный видеоредактор",icon:"▣",category:"Видео",href:'./craft.html?app=filmcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-lightcraft',title:"LightCraft",description:"RAW и цветокоррекция",icon:"◉",category:"Изображения",href:'./craft.html?app=lightcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-effectcraft',title:"EffectCraft",description:"Моушн-графика и визуальные эффекты",icon:"✧",category:"Видео",href:'./craft.html?app=effectcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-designcraft',title:"DesignCraft",description:"Вёрстка буклетов и макетов",icon:"▦",category:"Дизайн",href:'./craft.html?app=designcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-figcraft',title:"FigCraft",description:"Прототипирование и дизайн интерфейсов",icon:"▱",category:"Дизайн",href:'./craft.html?app=figcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-texturecraft',title:"TextureCraft",description:"Рисование 3D-текстур",icon:"▧",category:"3D и CAD",href:'./craft.html?app=texturecraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-materialcraft',title:"MaterialCraft",description:"Редактор процедурных материалов",icon:"⬡",category:"3D и CAD",href:'./craft.html?app=materialcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-soundcraft',title:"SoundCraft",description:"Многодорожечная запись и монтаж звука",icon:"♫",category:"Аудио",href:'./craft.html?app=soundcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-wordcraft',title:"WordCraft",description:"Создание и редактирование документов",icon:"▤",category:"Документы",href:'./craft.html?app=wordcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-deckcraft',title:"DeckCraft",description:"Презентации, слайды и переходы",icon:"▣",category:"Документы",href:'./craft.html?app=deckcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-cadcraft',title:"CADCraft",description:"Чертежи и техническое проектирование",icon:"⌗",category:"3D и CAD",href:'./craft.html?app=cadcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-gridcraft',title:"GridCraft",description:"Таблицы, формулы и диаграммы",icon:"▦",category:"Документы",href:'./craft.html?app=gridcraft',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {id:'artcraft-craft-anything',title:"Craft Anything",description:"Исследование и создание приложений",icon:"◇",category:"Анализ",href:'./craft.html?app=craft-anything',accept:'*/*',options:[],async run(){throw new Error('Откройте редактор в отдельной рабочей области.');}},
  {
    id:'pdf-workbench',title:'PDF-редактор',description:'Просмотр и редактирование PDF: страницы, объединение, аннотации, формы, OCR и защита',
    icon:'▤',category:'PDF',href:'./pdf.html',accept:'.pdf,application/pdf',options:[],
    async run(){throw new Error('Откройте PDF-редактор в отдельном рабочем пространстве.');}
  },
  tool('video-trim','Обрезка видео','Оставить выбранный фрагмент видео','✂','trim',[
    {key:'start',label:'Начало (сек.)',type:'number',default:'0',min:0,step:.001},
    {key:'end',label:'Конец (сек.; 0 — до конца)',type:'number',default:'0',min:0,step:.001},
    {key:'cutMode',label:'Точность обрезки',type:'select',choices:[['exact','Точно по границам (рекомендуется)'],['keyframe','По ключевым кадрам (начало может сместиться)']],default:'exact'},width], 'Видео', {note:'Совместимые MP4 обрезаются без перекодирования. Для WebM без перекодирования доступны границы ключевых кадров; точная обрезка между ними требует повторного кодирования.'}),
  tool('mute-video','Удалить звук','Удалить звуковую дорожку из видео','◌','mute',[width], 'Видео', {note:'Совместимые MP4 обрабатываются без перекодирования видео. Для остальных форматов используется обычный экспорт.'}),
  tool('video-crop','Кадрирование видео','Обрезать края кадра','▣','crop',[
    {key:'crop',label:'Обрезать с каждой стороны (%)',type:'number',default:'10',min:0,max:40,step:1},width], 'Видео', {note:'Чтобы настроить область кадра, переключитесь на исходное видео и перетащите угловые маркеры.'}),
  tool('video-flip','Отразить видео','Отразить изображение по горизонтали или вертикали','⇆','flip-h',[width], 'Видео', {
    async run({files,values,progress,signal}){const mode=values.axis==='vertical'?'flip-v':'flip-h';const result=await transformVideo({files,mode,options:values,onProgress:progress,signal});return {blob:result.blob,name:outputName(files[0],'flip',result.ext),fast:!!result.fast,method:result.method,info:result.info};},
    options:[{key:'axis',label:'Направление',type:'select',choices:[['horizontal','Горизонтально'],['vertical','Вертикально']],default:'horizontal'},width]
  }),
  tool('video-rotate','Поворот видео','Повернуть изображение на 90°, 180° или 270°','↻','rotate-90',[width],'Видео',{
    options:[{key:'degrees',label:'Угол',type:'select',choices:[['90','90°'],['180','180°'],['270','270°']],default:'90'},width],
    async run({files,values,progress,signal}){const result=await transformVideo({files,mode:`rotate-${values.degrees}`,options:values,onProgress:progress,signal});return {blob:result.blob,name:outputName(files[0],'rotate',result.ext),fast:!!result.fast,method:result.method,info:result.info};}
  }),
  tool('video-speed','Скорость видео','Изменить скорость воспроизведения','⏩','speed',[
    {key:'speed',label:'Скорость',type:'select',choices:[['0.5','0,5×'],['0.75','0,75×'],['1.25','1,25×'],['1.5','1,5×'],['2','2×']],default:'1.5'},width], 'Видео', {note:'У совместимых MP4 без звука скорость можно изменить без перекодирования. Если звуковая дорожка есть, потребуется обычный экспорт.'}),
  tool('video-loop','Повтор видео','Повторить ролик без перекодирования, если возможно','⟳','loop',[
    {key:'loops',label:'Количество повторений',type:'number',default:'2',min:1,max:10,step:1},width], 'Видео', {note:'Совместимые MP4 повторяются со звуком без перекодирования. Для несовместимых дорожек используется резервный экспорт.'}),
  tool('video-filter','Цветовой фильтр','Изменить цвет и яркость изображения','◐','filter',[
    {key:'filter',label:'Эффект',type:'select',choices:[['grayscale(1)','Чёрно-белый'],['sepia(1)','Сепия'],['contrast(1.4)','Контраст +40%'],['brightness(1.3)','Яркость +30%'],['saturate(1.6)','Насыщенность +60%'],['invert(1)','Негатив']],default:'grayscale(1)'},width]),
  tool('video-blur','Размытие видео','Размыть весь кадр','◍','blur',[
    {key:'blur',label:'Степень размытия',type:'number',default:'5',min:0,max:35,step:1},width]),
  tool('video-watermark','Текст поверх видео','Добавить текст в правый нижний угол','T','watermark',[
    {key:'text',label:'Текст',type:'text',default:'Моё видео'},width]),
  tool('video-converter','Конвертер видео','MP4, MOV, MKV, AVI, WebM и другие контейнеры','⇄','convert',[width,fps,engine], 'Видео', {note:'Совместимые H.264/AAC дорожки MOV/3GP перепаковываются в MP4 без потерь. Для MKV/AVI, HEVC, VP9, AV1, MPEG-4 и других кодеков применяется WebCodecs, а если требуется — FFmpeg/WASM. Первый запуск FFmpeg требует сети; файлы остаются на устройстве.'}),
  tool('video-compressor','Сжатие видео','Уменьшить размер файла, изменив качество видео','▤','compress',[
    {key:'bitrate',label:'Качество видео (битрейт)',type:'select',choices:[['300000','300 кбит/с'],['650000','650 кбит/с'],['1000000','1 Мбит/с'],['1800000','1,8 Мбит/с']],default:'650000'},width,engine]),
  tool('video-volume','Громкость видео','Изменить громкость звуковой дорожки','♫','volume',[
    {key:'gain',label:'Уровень звука',type:'select',choices:[['0.25','25%'],['0.5','50%'],['1','100%'],['1.5','150%'],['2','200%']],default:'1'},width]),
  tool('video-merge','Склеить видео','Соединить два видео в один файл','⊕','merge',[{key:'clipOrder',label:'Порядок клипов',type:'select',choices:[['normal','Сначала первый, затем второй'],['reverse','Сначала второй, затем первый']],default:'normal'},width], 'Видео',{maxFiles:2,requiredFiles:2,note:'Порядок клипов на временной шкале сохраняется при экспорте. Совместимые MP4 можно объединить без перекодирования.'}),
  tool('split-screen','Разделённый экран','Разместить два видео рядом в одном кадре','◫','split',[{key:'offsetSeconds',label:'Начало второго видео (сек.)',type:'number',default:'0',min:0,max:3600,step:.1,hint:'Второе видео начнётся с задержкой. До его начала правая часть кадра будет чёрной.'},width],'Видео',{maxFiles:2,requiredFiles:2,note:'Звук берётся только из первого видео. Положение дорожек на временной шкале соответствует результату.'}),
  tool('video-to-vr','Видео рядом с копией','Разместить исходное видео и его копию рядом','▥','vr',[width], 'Видео'),
  {
    id:'video-frames',title:'Кадр из видео',description:'Сохранить кадр из видео в PNG',icon:'▧',category:'Изображения',accept:videoAccept,
    options:[{key:'seconds',label:'Время кадра (сек.)',type:'number',default:'0',min:0,step:.001,hint:'Выберите момент на временной шкале или укажите время вручную.'}],
    async run({files,values,signal}){const {blob}=await frameFromVideo(files[0],values.seconds,signal);return {blob,name:outputName(files[0],'frame','png')};}
  },
  {
    id:'video-metadata',title:'Информация о видео',description:'Показать размер, длительность и разрешение видео',icon:'ⓘ',category:'Анализ',accept:videoAccept,
    options:[],async run({files,signal}){
      const data=await inspectVideo(files[0],signal);
      return {rows:[['Имя',data.name],['Тип файла',data.type],['Размер',`${(data.size/1024/1024).toFixed(2)} МБ`],['Разрешение',`${data.width} × ${data.height}`],['Длительность',`${asTime(data.duration)} (${data.duration.toFixed(2)} сек.)`],...(data.videoCodec?[['Видеокодек',data.videoCodec]]:[]),...(data.audioCodec?[['Аудиокодек',data.audioCodec]]:[]),['Изменён',new Date(data.modified).toLocaleString('ru-RU')]]};
    }
  },
  {
    id:'video-to-audio',title:'Извлечь звук',description:'Скачать звуковую дорожку отдельным файлом',icon:'♪',category:'Аудио',accept:videoAccept,options:[],
    async run({files,progress,signal}){const result=await extractAudio(files[0],{onProgress:progress,signal});return {blob:result.blob,name:outputName(files[0],'audio',result.ext),fast:!!result.fast,method:result.method,info:result.info};}
  },
  {
    id:'screen-recorder',title:'Запись экрана',description:'Записать экран или вкладку браузера',icon:'▣',category:'Запись',isCapture:true,options:[],
    async run({stop,signal,progress,captureStream}){const {blob,ext}=await recordDevice('screen',{onStop:stop,onProgress:progress,onStream:captureStream,signal});return {blob,name:`screen-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`};}
  },
  {
    id:'webcam-recorder',title:'Запись камеры',description:'Записать изображение с камеры и звук микрофона',icon:'◎',category:'Запись',isCapture:true,options:[],
    async run({stop,signal,progress,captureStream}){const {blob,ext}=await recordDevice('webcam',{onStop:stop,onProgress:progress,onStream:captureStream,signal});return {blob,name:`webcam-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`};}
  },
  {
    id:'subtitle-converter',title:'SRT ⇄ VTT',description:'Преобразовать субтитры из SRT в VTT и обратно',icon:'≡',category:'Субтитры',accept:'.srt,.vtt,text/plain',options:[],
    async run({files}){const f=files[0];const source=await f.text();const isVtt=/^\uFEFF?WEBVTT\b/i.test(source.trimStart())||/\.vtt$/i.test(f.name);
      let result,ext;
      if(isVtt){result=vttToSrt(source);ext='srt';}else{result=srtToVtt(source);ext='vtt';}
      return {blob:new Blob([result],{type:'text/plain;charset=utf-8'}),name:outputName(f,'converted',ext)};
    }
  },
  {
    id:'subtitle-shift',title:'Сдвиг субтитров',description:'Сдвинуть все реплики SRT вперёд или назад',icon:'⏱',category:'Субтитры',accept:'.srt,text/plain',options:[{key:'seconds',label:'Сдвиг по времени (сек.; минус — раньше)',type:'number',default:'2',step:.1}],
    async run({files,values}){const source=await files[0].text();const result=shiftSubtitle(source,Number(values.seconds)||0);return {blob:new Blob([result],{type:'text/plain;charset=utf-8'}),name:outputName(files[0],'shift','srt')};}
  },
  {
    id:'subtitle-merger',title:'Объединить субтитры',description:'Собрать реплики из двух файлов SRT в один',icon:'☷',category:'Субтитры',accept:'.srt,text/plain',maxFiles:2,requiredFiles:2,options:[],
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
