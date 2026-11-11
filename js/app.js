import {tools} from './tools.js';
import {recordEvent,recordOperation} from './analytics.js';
import {mountEditor} from './editor.js';
import './version.js';
import {applyPreset,savePreset,resetPreset} from './presets.js';
import {supportedMediaFeatures} from './media.js';

const $=selector=>document.querySelector(selector);
const root=$('#tool-grid');
const categories=$('#categories');
const workspace=$('#workspace');
const toolContent=$('#tool-content');
const resultArea=$('#result-area');
const status=$('#tool-status');
const selected={category:'Все',search:''};
const LAST_TOOL_KEY='lokit:last-tool';
const FAVORITES_KEY='lokit:favorites:v1';
const allowedIds=new Set(tools.map(t=>t.id));
function readFavorites(){
  try{
    const stored=JSON.parse(localStorage.getItem(FAVORITES_KEY)||'[]');
    return new Set(Array.isArray(stored)?stored.filter(id=>typeof id==='string'&&allowedIds.has(id)):[]);
  }catch{return new Set();}
}
const favorites=readFavorites();
function updateFavoritesStore(){
  try{localStorage.setItem(FAVORITES_KEY,JSON.stringify([...favorites]));}catch{}
}
function toggleFavorite(tool){
  if(favorites.has(tool.id))favorites.delete(tool.id);else favorites.add(tool.id);
  updateFavoritesStore();updateFilters();renderCards();updateFavoriteButton();
}
function updateFavoriteButton(){
  const btn=$('#favorite-tool');if(!btn)return;
  const saved=Boolean(currentTool&&favorites.has(currentTool.id));
  btn.textContent=saved?'★ В избранном':'☆ В избранное';
  btn.setAttribute('aria-pressed',String(saved));
  btn.setAttribute('aria-label',saved?'Убрать инструмент из избранного':'Добавить инструмент в избранное');
}
const categoryNames=['Все','Избранное'];
const groupNames=['Видео','Аудио','Изображения','Субтитры','Запись','Анализ'];
const GROUPS_KEY='lokit:sidebar:groups:v1';
const SIDEBAR_COLLAPSED_KEY='lokit:sidebar:collapsed:v1';
function savedGroups(){
  try{
    const value=JSON.parse(localStorage.getItem(GROUPS_KEY)||'null');
    if(Array.isArray(value))return new Set(value.filter(name=>groupNames.includes(name)));
  }catch{}
  return new Set(['Видео']);
}
const expandedGroups=savedGroups();
function saveGroups(){try{localStorage.setItem(GROUPS_KEY,JSON.stringify([...expandedGroups]));}catch{}}
function savedSidebarCollapsed(){try{return localStorage.getItem(SIDEBAR_COLLAPSED_KEY)==='true';}catch{return false;}}
const categoryIcons={Все:'◈',Избранное:'★',Видео:'▣',Аудио:'♪',Изображения:'▧',Анализ:'ⓘ',Запись:'●',Субтитры:'≡'};
const videoSections=[
  ['Монтаж',['video-trim','video-crop','video-merge','video-speed','video-loop','video-flip','video-rotate','split-screen']],
  ['Эффекты',['video-filter','video-blur','video-watermark','video-to-vr']],
  ['Звук',['mute-video','video-volume']],
  ['Экспорт',['video-converter','video-compressor']]
];
function videoSectionFor(id){return videoSections.find(([,ids])=>ids.includes(id))?.[0]||'Другие';}
let currentTool=null,controller=null,stopRecording=null,activeEditor=null,downloadUrls=[];
const sidebar=$('#tool-sidebar');
const sidebarToggle=$('#sidebar-toggle');
const isMobileSidebar=()=>window.matchMedia('(max-width: 900px)').matches;
function syncSidebarToggle(){
  const open=isMobileSidebar()?document.body.classList.contains('sidebar-open'):!document.body.classList.contains('sidebar-collapsed');
  sidebarToggle?.setAttribute('aria-expanded',String(open));
  sidebarToggle?.setAttribute('aria-label',open?'Свернуть каталог инструментов':'Открыть каталог инструментов');
  $('#sidebar-close')?.setAttribute('aria-label',isMobileSidebar()?'Закрыть меню инструментов':'Свернуть каталог инструментов');
}
function setSidebarOpen(open,{restoreFocus=true,savePreference=true}={}){
  if(!isMobileSidebar()){
    document.body.classList.toggle('sidebar-collapsed',!open);
    if(savePreference)try{localStorage.setItem(SIDEBAR_COLLAPSED_KEY,String(!open));}catch{}
    syncSidebarToggle();
    if(open)sidebar?.querySelector('#search')?.focus({preventScroll:true});
    else if(restoreFocus)sidebarToggle?.focus({preventScroll:true});
    return;
  }
  const wasOpen=document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open',open);
  const content=document.querySelector('.app-content');
  if(content)content.inert=open;
  syncSidebarToggle();
  if(open){sidebar?.querySelector('#search')?.focus({preventScroll:true});}
  else if(wasOpen&&restoreFocus){sidebarToggle?.focus({preventScroll:true});}
}
if(!isMobileSidebar())document.body.classList.toggle('sidebar-collapsed',savedSidebarCollapsed());
syncSidebarToggle();
sidebarToggle?.addEventListener('click',()=>{
  const open=isMobileSidebar()?document.body.classList.contains('sidebar-open'):!document.body.classList.contains('sidebar-collapsed');
  setSidebarOpen(!open);
});
$('#hero-open-tools')?.addEventListener('click',event=>{
  event.preventDefault();setSidebarOpen(true);
  if(!isMobileSidebar())sidebar?.scrollIntoView({block:'nearest',behavior:'smooth'});
});
$('#sidebar-close')?.addEventListener('click',()=>setSidebarOpen(false));
$('#sidebar-backdrop')?.addEventListener('click',()=>setSidebarOpen(false));
window.matchMedia('(min-width: 901px)').addEventListener('change',event=>{
  document.body.classList.remove('sidebar-open');
  const content=document.querySelector('.app-content');if(content)content.inert=false;
  document.body.classList.toggle('sidebar-collapsed',event.matches&&savedSidebarCollapsed());
  syncSidebarToggle();
});

function escapeText(t){return String(t||'');}
function formatDuration(seconds){
  const s=Math.max(0,Math.floor(Number(seconds)||0));
  const h=Math.floor(s/3600),m=Math.floor(s/60)%60,sec=s%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
const progressStages={
  preparing:'Подготовка файлов',processing:'Обработка файла',finalizing:'Формирование результата',
  recording:'Идёт запись',complete:'Готово',cancelled:'Операция отменена',error:'Ошибка обработки'
};
function setupProgress(form){
  const panel=document.createElement('div');panel.className='progress-panel hidden';panel.setAttribute('aria-label','Ход выполнения');
  const heading=document.createElement('div');heading.className='progress-heading';
  const stage=document.createElement('strong');stage.className='progress-stage';
  const percentLabel=document.createElement('span');percentLabel.className='progress-percent';
  heading.append(stage,percentLabel);
  const bar=document.createElement('progress');bar.className='progress';bar.max=100;
  bar.setAttribute('aria-label','Прогресс обработки');
  const details=document.createElement('div');details.className='progress-details';
  panel.append(heading,bar,details);form.append(panel);
  return info=>{
    const state=typeof info==='number'?{stage:'processing',percent:info}:info||{};
    const kind=state.stage||'processing';
    panel.classList.remove('hidden');
    panel.dataset.stage=kind;
    stage.textContent=state.description||progressStages[kind]||'Выполнение';
    const hasPercent=Number.isFinite(Number(state.percent))&&state.percent!==null&&state.percent!==undefined;
    if(hasPercent){
      const value=Math.max(0,Math.min(kind==='complete'?100:99,Number(state.percent)));
      bar.value=value;
      percentLabel.textContent=`${Math.floor(value)}%`;
    }else{
      bar.removeAttribute('value');
      percentLabel.textContent=kind==='recording'?'REC':'…';
    }
    const parts=[];
    if(Number.isFinite(state.current)&&Number.isFinite(state.total)&&state.total>0){
      parts.push(`Обработано: ${formatDuration(state.current)} из ${formatDuration(state.total)}`);
    }
    if(Number.isFinite(state.elapsedSeconds))parts.push(`${kind==='recording'?'Записывается':'Прошло'}: ${formatDuration(state.elapsedSeconds)}`);
    if(Number.isFinite(state.remainingSeconds)&&kind==='processing')parts.push(`Осталось ≈ ${formatDuration(state.remainingSeconds)}`);
    if(kind==='complete'&&!parts.length)parts.push('Результат готов к сохранению');
    if(kind==='preparing'&&!parts.length)parts.push('Чтение и подготовка исходного файла');
    if(kind==='finalizing'&&!parts.length)parts.push('Завершаем запись и собираем результат');
    if(kind==='recording'&&!parts.length)parts.push('Нажмите «Остановить запись» для сохранения');
    details.textContent=parts.join('  ·  ');
  };
}
function showStatus(text='',error=false){status.textContent=text;status.classList.toggle('error',error);}
function categoryCount(category){return category==='Все'?tools.length:category==='Избранное'?favorites.size:tools.filter(t=>t.category===category).length;}
function findToolById(id){return tools.find(tool=>tool.id===id) || null;}
function saveLastTool(tool){if(tool?.id){try{localStorage.setItem(LAST_TOOL_KEY,tool.id);}catch{}} updateLastToolButtons();}
function getLastTool(){try{return findToolById(localStorage.getItem(LAST_TOOL_KEY));}catch{return null;}}
function updateLastToolButtons(){
  const last=getLastTool();
  for(const node of [$('#open-last-tool'),$('#hero-last-tool')]){
    if(!node)continue;
    node.disabled=!last;
    node.textContent=last?`Последний: ${last.title}`:'Последний инструмент';
  }
  const recent=$('#sidebar-recent'),recentButton=$('#sidebar-recent-button');
  recent?.classList.toggle('hidden',!last);
  if(last&&recentButton){
    $('#sidebar-recent-name').textContent=last.title;
    $('#sidebar-recent-icon').textContent=last.icon;
    recentButton.title=last.description;
    recentButton.setAttribute('aria-label',`Продолжить: ${last.title}`);
  }
function updateHeroStats(){const el=$('#hero-tool-count');if(el)el.textContent=String(tools.length);}

function addResult(result){
  if(result.rows){
    const table=document.createElement('table');table.className='table-info';
    for(const [title,value] of result.rows){const row=table.insertRow();row.insertCell().textContent=title;row.insertCell().textContent=String(value);}
    resultArea.append(table);return;
  }
  if(!result.blob)return;
  const url=URL.createObjectURL(result.blob);downloadUrls.push(url);
  const container=document.createElement('div');container.className='download';
  const a=document.createElement('a');a.href=url;a.download=result.name;a.textContent='Скачать результат';
  const label=document.createElement('span');label.textContent=result.name;
  const details=document.createElement('small');details.textContent=`${(result.blob.size/1024/1024).toFixed(2)} МБ · ${result.fast?'без перекодирования':result.method==='webcodecs'?'WebCodecs':result.method==='ffmpeg-wasm'?'FFmpeg/WASM':'обработка завершена'} · готово к сохранению`;
  container.append(a,label,details);if(result.info){const note=document.createElement('small');note.textContent=result.info;container.append(note);}resultArea.append(container);
}

function clearResults(){
  for(const url of downloadUrls)URL.revokeObjectURL(url);
  downloadUrls=[];resultArea.replaceChildren();
}
function resetWorkspace(){
  controller?.abort();stopRecording?.();stopRecording=null;controller=null;
  activeEditor?.destroy();activeEditor=null;
  clearResults();toolContent.replaceChildren();showStatus();
}

function makeField(def){
  const label=document.createElement('label');label.className='field';label.textContent=def.label;
  let field;
  if(def.type==='select'){
    field=document.createElement('select');
    for(const [value,text] of def.choices){const opt=document.createElement('option');opt.value=value;opt.textContent=text;field.append(opt);}
  }else{
    field=document.createElement('input');field.type=def.type||'text';
    if(def.min!==undefined)field.min=def.min;
    if(def.max!==undefined)field.max=def.max;
    if(def.step!==undefined)field.step=def.step;
    if(field.type==='text')field.maxLength=80;
  }
  field.name=def.key;field.value=def.default??'';label.append(field);
  if(def.hint){const small=document.createElement('small');small.textContent=def.hint;label.append(small);}
  return label;
}

function openTool(tool){
  resetWorkspace();currentTool=tool;saveLastTool(tool);recordEvent('open',tool.id);updateFavoriteButton();
  document.body.classList.add('has-active-tool');
  renderCards();if(isMobileSidebar())setSidebarOpen(false,{restoreFocus:false});
  $('#tool-title').textContent=tool.title;
  $('#tool-description').textContent=tool.description;
  workspace.classList.remove('hidden');

  const form=document.createElement('form');form.noValidate=true;
  form.className='studio-form';
  const layout=document.createElement('div');layout.className='studio-layout';
  const previewColumn=document.createElement('div');previewColumn.className='studio-main';
  const settings=document.createElement('aside');settings.className='studio-settings';
  settings.setAttribute('aria-label','Настройки инструмента');
  settings.append(Object.assign(document.createElement('h3'),{textContent:'Настройки'}));
  layout.append(previewColumn,settings);
  let input;
  if(!tool.isCapture){
    const zone=document.createElement('label');zone.className='dropzone';
    const zoneTitle=document.createElement('span');zoneTitle.className='dropzone-title';zoneTitle.textContent=tool.maxFiles?'Перетащите файлы сюда или выберите их':'Перетащите файл сюда или выберите его';
    const zoneSubtitle=document.createElement('span');zoneSubtitle.className='dropzone-subtitle';zoneSubtitle.textContent=tool.maxFiles?`Можно выбрать до ${tool.maxFiles} файлов`:'Поддерживается один входной файл';
    input=document.createElement('input');input.type='file';input.accept=tool.accept||'*/*';
    input.multiple=Boolean(tool.maxFiles);input.required=true;
    zone.append(zoneTitle,zoneSubtitle,input);
    const hint=document.createElement('span');hint.className='filehint';hint.textContent='Файлы обрабатываются локально на вашем устройстве';zone.append(hint);
    previewColumn.append(zone);
    input.addEventListener('change',()=>{
      hint.textContent=Array.from(input.files).map(f=>f.name).join(' · ')||'Файл не выбран';
      activeEditor?.update(Array.from(input.files));
    });
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');const files=e.dataTransfer.files;if(!files?.length)return;
      try{input.files=files;input.dispatchEvent(new Event('change'));}catch{hint.textContent='Выберите файл через поле загрузки.';}
    });
  }

  let resetSettings=null;
  if(tool.options?.length){
    const fields=document.createElement('div');fields.className='field-grid';
    for(const def of tool.options)fields.append(makeField(def));
    settings.append(fields);
    const presetHelp=document.createElement('p');presetHelp.className='studio-settings-hint';
    presetHelp.textContent='Параметры сохраняются только в этом браузере. Файлы не сохраняются.';
    resetSettings=document.createElement('button');resetSettings.className='secondary studio-reset-settings';
    resetSettings.type='button';resetSettings.textContent='Сбросить настройки';
    settings.append(presetHelp,resetSettings);
  }
  if(tool.note){const info=document.createElement('p');info.className='small subtle';info.textContent=tool.note;settings.append(info);}

  const actions=document.createElement('div');actions.className='actions';
  const start=document.createElement('button');start.className='primary';start.type='submit';start.textContent=tool.isCapture?'Начать запись':'Выполнить';
  const cancel=document.createElement('button');cancel.className='secondary';cancel.type='button';cancel.textContent='Отмена';cancel.disabled=true;
  const stop=document.createElement('button');stop.className='danger hidden';stop.type='button';stop.textContent='Остановить запись';
  actions.append(start,cancel,stop);settings.append(actions);
  if(!tool.options?.length){
    const hint=document.createElement('p');hint.className='studio-settings-hint';
    hint.textContent=tool.isCapture?'Выберите источник и начинайте запись.':'Дополнительные настройки не нужны — можно выполнять операцию.';
    settings.insertBefore(hint,actions);
  }
  form.append(layout);
  const restored=applyPreset(tool,form);
  activeEditor=mountEditor({host:previewColumn,tool,form});
  if(restored){
    const note=document.createElement('p');note.className='studio-settings-hint';
    note.textContent='Восстановлены настройки предыдущего сеанса. Выберите файл заново.';
    settings.prepend(note);
  }
  resetSettings?.addEventListener('click',()=>{
    resetPreset(tool,form);
    clearResults();form.querySelector('.progress-panel')?.classList.add('hidden');
    showStatus('Настройки сброшены к значениям по умолчанию.');
  });
  if(tool.category==='Видео'||tool.category==='Аудио'||tool.category==='Изображения'){
    const features=supportedMediaFeatures();
    const capability=document.createElement('p');capability.className='studio-settings-hint';
    capability.textContent=features.mediaRecorder
      ?`Для совместимых MP4 доступны быстрые обрезка, склейка, удаление звука и изменение скорости без аудио. WebM обрезается без перекодирования на ключевых кадрах. В остальных случаях используется MediaRecorder. ${features.webCodecs?'WebCodecs доступен.':''}`
      :'Кодирование MediaRecorder недоступно в этом браузере. Инструменты анализа и кадров могут работать.';
    settings.append(capability);
  }
  const setProgress=setupProgress(form);
  // A result produced with earlier settings is stale after any export-affecting change.
  function settingsChanged(event){
    if(controller)return;
    const target=event.target;
    if(!target.matches?.('input[name], select[name], textarea[name], input[type="file"]')&&!target.closest?.('.studio-cue-list'))return;
    if(target.name&&(tool.options||[]).some(def=>def.key===target.name))savePreset(tool,form);
    if(downloadUrls.length||resultArea.children.length)clearResults();
    form.querySelector('.progress-panel')?.classList.add('hidden');
    showStatus();
  }
  form.addEventListener('input',settingsChanged);
  form.addEventListener('change',settingsChanged);
  form.addEventListener('lokit-editor-change',()=>{if(!controller){clearResults();form.querySelector('.progress-panel')?.classList.add('hidden');showStatus();}});
  function lockSettings(locked){
    for(const control of form.querySelectorAll('input, select, textarea'))control.disabled=locked;
    if(resetSettings)resetSettings.disabled=locked;
    const preview=form.querySelector('.studio-main');
    if(preview)preview.inert=locked; // Also block keyboard and pointer changes in imported timeline.
    form.setAttribute('aria-busy',String(locked));
  }

  stop.addEventListener('click',()=>stopRecording?.());
  cancel.addEventListener('click',()=>controller?.abort());

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(controller)return;
    if(!form.reportValidity()){
      showStatus('Проверьте значения параметров и выбранные файлы.',true);
      return;
    }
    const originalFiles=tool.isCapture?[]:Array.from(input.files);
    let files;
    try{files=tool.isCapture?[]:(await activeEditor?.getFiles(originalFiles))||originalFiles;}
    catch(error){showStatus(error?.message||'Неверные параметры редактирования.',true);return;}
    if(!tool.isCapture&&files.length<(tool.requiredFiles||1)){showStatus(`Выберите ${tool.requiredFiles||1} файл(а).`,true);return;}
    if(files.length>(tool.maxFiles||1)){showStatus(`Можно выбрать не больше ${tool.maxFiles||1} файла(ов).`,true);return;}
    if(currentTool!==tool||!form.isConnected)return;
    const startValue=Number(form.elements.namedItem('start')?.value||0);
    const endValue=Number(form.elements.namedItem('end')?.value||0);
    if(tool.id==='video-trim'&&endValue>0&&startValue>=endValue){
      showStatus('Конец фрагмента должен быть позже начала.',true);
      return;
    }
    clearResults();
    const values=Object.fromEntries(new FormData(form));
    const runController=new AbortController();controller=runController;lockSettings(true);start.disabled=true;cancel.disabled=false;
    const isCurrent=()=>currentTool===tool&&controller===runController;
    const started=performance.now();
    let latestProgress=0;
    setProgress({stage:'preparing',description:tool.isCapture?'Ожидание разрешения браузера':'Подготовка файлов'});
    form.querySelector('.progress-panel')?.scrollIntoView({behavior:'smooth',block:'center'});
    showStatus();
    let active=true;
    const handleProgress=update=>{
      if(!active||!isCurrent())return;
      const state=typeof update==='number'?{stage:'processing',percent:update}:update||{};
      const elapsedSeconds=(performance.now()-started)/1000;
      const next={...state,elapsedSeconds: Number.isFinite(state.elapsedSeconds)?state.elapsedSeconds:elapsedSeconds};
      if(state.stage==='processing'){
        const fraction=Math.max(0,Math.min(99,Number(state.percent)||0));
        latestProgress=Math.max(latestProgress,fraction);
        next.percent=latestProgress;
        if(latestProgress>=8&&elapsedSeconds>=3){
          next.remainingSeconds=Math.max(0,elapsedSeconds*(100-latestProgress)/latestProgress);
        }
      }
      setProgress(next);
    };
    const stopHandler=fn=>{if(!isCurrent())return;stopRecording=fn;stop.classList.toggle('hidden',!fn);if(fn)showStatus();};
    try{
      const result=await tool.run({files,values,signal:runController.signal,stop:stopHandler,progress:handleProgress,captureStream:stream=>activeEditor?.setStream?.(stream)});
      if(!runController.signal.aborted&&isCurrent()){
        addResult(result);
        recordOperation(tool.id,'success',files,result,(performance.now()-started));
        setProgress({stage:'complete',percent:100,elapsedSeconds:(performance.now()-started)/1000});
        showStatus('Готово. Результат находится только в вашем браузере.');
      }else{
        recordOperation(tool.id,'cancelled',files,null,(performance.now()-started));
        if(isCurrent()){
          setProgress({stage:'cancelled',elapsedSeconds:(performance.now()-started)/1000});
          showStatus('Операция отменена.');
        }
      }
    }catch(e){
      const wasCancelled=e.name==='AbortError'||runController.signal.aborted;
      recordOperation(tool.id,wasCancelled?'cancelled':'error',files,null,(performance.now()-started));
      if(isCurrent()){
        setProgress({stage:wasCancelled?'cancelled':'error',elapsedSeconds:(performance.now()-started)/1000});
        showStatus(wasCancelled?'Операция отменена.':e.message||'Произошла ошибка.',!wasCancelled);
      }
    }
    finally{active=false;lockSettings(false);start.disabled=false;cancel.disabled=true;stop.classList.add('hidden');
      if(isCurrent()){stopRecording=null;controller=null;}
    }
  });

  toolContent.append(form);
  workspace.scrollIntoView({behavior:'smooth',block:'start'});
  $('#tool-title').focus({preventScroll:true});
}

function updateFilters(){
  categories.replaceChildren();
  for(const category of categoryNames){
    const button=document.createElement('button');button.type='button';button.className='chip'+(selected.category===category?' active':'');
    const icon=document.createElement('span');icon.textContent=categoryIcons[category]||'•';
    const text=document.createElement('span');text.textContent=category;
    const count=document.createElement('span');count.className='chip-count';count.textContent=String(categoryCount(category));
    button.append(icon,text,count);
    button.setAttribute('aria-pressed',String(selected.category===category));
    button.addEventListener('click',()=>{selected.category=category;updateFilters();renderCards();});
    categories.append(button);
  }
}

function updateExpandControl(){
  const allExpanded=groupNames.every(name=>expandedGroups.has(name));
  const control=$('#sidebar-expand-all');if(!control)return;
  control.textContent=allExpanded?'Свернуть':'Развернуть';
  control.setAttribute('aria-label',allExpanded?'Свернуть все разделы':'Развернуть все разделы');
  control.disabled=Boolean(selected.search)||selected.category==='Избранное';
}
function renderCards(){
  const matching=tools.filter(t=>(selected.category==='Все'||(selected.category==='Избранное'?favorites.has(t.id):t.category===selected.category))&&
    `${t.title} ${t.description} ${t.id} ${t.category}`.toLocaleLowerCase('ru').includes(selected.search));
  const oldScroll=root.scrollTop;
  root.replaceChildren();
  for(const category of (selected.category==='Избранное'?['Избранное']:groupNames)){
    const matches=matching.filter(t=>category==='Избранное'?true:t.category===category);
    if(!matches.length)continue;
    const group=document.createElement('details');group.className='sidebar-group';group.dataset.group=category;
    group.open=Boolean(selected.search)||selected.category==='Избранное'||expandedGroups.has(category);
    const summary=document.createElement('summary');summary.className='sidebar-group-title';
    const symbol=document.createElement('span');symbol.className='sidebar-group-icon';symbol.textContent=categoryIcons[category]||'•';
    const label=document.createElement('strong');label.textContent=category;
    const count=document.createElement('span');count.className='sidebar-group-count';count.textContent=String(matches.length);
    const caret=document.createElement('span');caret.className='sidebar-chevron';caret.setAttribute('aria-hidden','true');caret.textContent='⌄';
    summary.append(symbol,label,count,caret);
    group.append(summary);
    group.addEventListener('toggle',()=>{
      if(selected.search||selected.category==='Избранное')return;
      if(group.open)expandedGroups.add(category);else expandedGroups.delete(category);
      saveGroups();updateExpandControl();
    });
    const list=document.createElement('div');list.className='sidebar-tools';
    const ordered=category==='Видео'?[...matches].sort((a,b)=>{
      const ai=videoSections.findIndex(([,ids])=>ids.includes(a.id));
      const bi=videoSections.findIndex(([,ids])=>ids.includes(b.id));
      return (ai<0?videoSections.length:ai)-(bi<0?videoSections.length:bi);
    }):matches;
    let currentSection='';
    for(const t of ordered){
      if(category==='Видео'){
        const section=videoSectionFor(t.id);
        if(section!==currentSection){
          const divider=document.createElement('span');divider.className='sidebar-subsection';divider.textContent=section;
          list.append(divider);currentSection=section;
        }
      }
      const row=document.createElement('div');row.className='sidebar-tool-row';row.dataset.toolId=t.id;
      const button=document.createElement('button');button.className='tool-card sidebar-tool'+(currentTool?.id===t.id?' is-active':'');
      button.type='button';button.dataset.toolId=t.id;button.title=t.description;
      button.setAttribute('aria-label',`${t.title}. ${t.description}`);
      if(currentTool?.id===t.id)button.setAttribute('aria-current','true');
      const icon=document.createElement('span');icon.className='sidebar-tool-icon';icon.textContent=t.icon;icon.setAttribute('aria-hidden','true');
      const heading=document.createElement('strong');heading.textContent=t.title;
      button.append(icon,heading);button.addEventListener('click',()=>openTool(t));
      const star=document.createElement('button');star.type='button';star.className='sidebar-favorite'+(favorites.has(t.id)?' is-favorite':'');
      star.textContent=favorites.has(t.id)?'★':'☆';star.dataset.favoriteId=t.id;
      star.setAttribute('aria-pressed',String(favorites.has(t.id)));
      star.setAttribute('aria-label',`${favorites.has(t.id)?'Убрать из избранного':'Добавить в избранное'}: ${t.title}`);
      star.title=favorites.has(t.id)?'Убрать из избранного':'Добавить в избранное';
      star.addEventListener('click',()=>{
        const keepFocus=selected.category!=='Избранное';toggleFavorite(t);
        if(keepFocus)root.querySelector(`[data-favorite-id="${t.id}"]`)?.focus({preventScroll:true});
        else categories.querySelector('.chip.active')?.focus({preventScroll:true});
      });
      row.append(button,star);list.append(row);
    }
    group.append(list);root.append(group);
  }
  const counter=$('#counter');if(counter)counter.textContent=`${matching.length} из ${tools.length}`;
  const empty=$('#no-results');empty.classList.toggle('hidden',matching.length>0);
  if(!matching.length){
    const title=empty.querySelector('strong'),hint=empty.querySelector('p');
    const noFavorites=selected.category==='Избранное'&&!favorites.size&&!selected.search;
    title.textContent=noFavorites?'Избранное пока пусто':'Инструменты не найдены';
    hint.textContent=noFavorites?'Нажмите ☆ рядом с инструментом, чтобы добавить его сюда.':'Попробуйте другой запрос или сбросьте фильтры.';
  }
  updateExpandControl();
  root.scrollTop=oldScroll;
}

$('#search').addEventListener('input',e=>{
  selected.search=e.target.value.trim().toLocaleLowerCase('ru');
  $('#clear-search').classList.toggle('hidden',!selected.search);
  renderCards();
});
$('#clear-search').addEventListener('click',()=>{
  const input=$('#search');input.value='';selected.search='';$('#clear-search').classList.add('hidden');renderCards();input.focus();
});
$('#reset-sidebar-filters').addEventListener('click',()=>{
  selected.category='Все';selected.search='';$('#search').value='';
  $('#clear-search').classList.add('hidden');updateFilters();renderCards();$('#search').focus({preventScroll:true});
});
$('#sidebar-expand-all').addEventListener('click',()=>{
  const expand=!groupNames.every(name=>expandedGroups.has(name));
  expandedGroups.clear();if(expand)groupNames.forEach(name=>expandedGroups.add(name));
  saveGroups();renderCards();
});
$('#sidebar-recent-button').addEventListener('click',()=>{const last=getLastTool();if(last)openTool(last);});
function closeWorkspace(){
  const focused=workspace.contains(document.activeElement);
  const toolId=currentTool?.id;
  resetWorkspace();workspace.classList.add('hidden');currentTool=null;document.body.classList.remove('has-active-tool');renderCards();
  if(focused){
    const target=[...root.querySelectorAll('.tool-card')].find(card=>card.dataset.toolId===toolId);
    (window.matchMedia('(max-width: 900px)').matches?sidebarToggle:(target||$('#search')))?.focus({preventScroll:true});
  }
}
$('#close-workspace').addEventListener('click',closeWorkspace);
$('#favorite-tool').addEventListener('click',()=>{if(currentTool)toggleFavorite(currentTool);});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
    event.preventDefault();setSidebarOpen(true);$('#search').focus({preventScroll:true});$('#search').select();return;
  }
  if(event.key==='Tab'&&isMobileSidebar()&&document.body.classList.contains('sidebar-open')){
    const focusable=[...sidebar.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href],summary')].filter(node=>node.getClientRects().length);
    const first=focusable[0],last=focusable[focusable.length-1];
    if(first&&last&&(event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last)){
      event.preventDefault();(event.shiftKey?last:first).focus();return;
    }
  }
  if(event.key==='Escape'&&document.body.classList.contains('sidebar-open')){event.preventDefault();setSidebarOpen(false);return;}
  if(event.key==='Escape'&&!workspace.classList.contains('hidden')&&event.target.closest?.('.studio-cue-list')===null){
    event.preventDefault();closeWorkspace();
  }
});

for(const node of [$('#open-last-tool'),$('#hero-last-tool')]){
  node?.addEventListener('click',()=>{const last=getLastTool();if(last)openTool(last);});
}

function networkStatus(){
  const online=navigator.onLine;const node=$('#network-status');
  node.textContent=online?'Локальная обработка':'Офлайн-режим';
  node.classList.toggle('offline',!online);
}

window.addEventListener('online',networkStatus);
window.addEventListener('offline',networkStatus);

recordEvent('view');
updateHeroStats();
updateFilters();
renderCards();
updateLastToolButtons();
networkStatus();

if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{}));
