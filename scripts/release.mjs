#!/usr/bin/env node
// One command updates app version, static fallback, PWA cache and release notes.
// Usage: node scripts/release.mjs 0.4.0 "Что нового"
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(resolve(ROOT,p),'utf8');
const write=(p,t)=>writeFileSync(resolve(ROOT,p),t,'utf8');
const VERSION_FILE='js/version.js';
const PAGES=['index.html','analytics.html','about.html','batch.html'];
const VERSION_PATTERN=/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/;
const version=read(VERSION_FILE).match(VERSION_PATTERN)?.[1];
const check=process.argv.includes('--check');
if(!version)throw new Error('APP_VERSION не найден');
function assert(condition,message){if(!condition)throw new Error(message);}
function checkProject(expected=version){
 const code=read('sw.js');
 assert(code.includes(`lokit-v${expected}`),'Номер PWA-кеша отличается от версии');
 assert(read('CHANGELOG.md').includes(`## v${expected}`),'Нет записи о текущей версии в CHANGELOG.md');
 assert(JSON.parse(read('package.json')).version===expected,'Версия package.json отличается от приложения');
 for(const page of PAGES){
   const html=read(page);
   assert(html.includes(`v${expected}`),`Неверная плашка версии: ${page}`);
   assert(html.includes('./style-enhancements.css'),`Отсутствуют стили редактора: ${page}`);
   assert(html.includes('./layout-compact.css'),`Отсутствуют адаптивные стили компоновки: ${page}`);
   if(page==='index.html')assert(html.includes('./sidebar.css'),'Не подключены стили бокового меню');
 }
 for(const path of ['js/media.js','js/editor.js','js/edit-history.js','js/precision-timeline.js','js/multitrack.js','js/subtitle-timeline.js','js/render.js','js/presets.js','style-enhancements.css','layout-compact.css','sidebar.css','batch.css','js/batch-page.js','js/batch-queue.js','js/zip.js']){
   assert(existsSync(resolve(ROOT,path)),`Файл не найден: ${path}`);
 }
 for(const asset of ['./js/render.js','./js/edit-history.js','./js/precision-timeline.js','./js/multitrack.js','./js/subtitle-timeline.js','./js/presets.js','./js/capabilities.js','./style-enhancements.css','./layout-compact.css','./sidebar.css','./batch.html','./batch.css','./js/batch-page.js','./js/batch-queue.js','./js/zip.js']){
   assert(code.includes(asset),`Новый файл не закеширован PWA: ${asset}`);
 }
 console.log(`PASS: version v${expected}, changelog, pages, PWA and assets`);
}
if(check){checkProject();process.exit(0);}
const next=process.argv[2];
const description=process.argv.slice(3).join(' ').trim();
if(!/^\d+\.\d+\.\d+$/.test(next||'')){
 console.error('Укажите номер версии: node scripts/release.mjs 0.4.0 "Описание изменений"');
 process.exit(1);
}
if(!description)throw new Error('Нужно кратко описать изменения');
if(next===version)throw new Error(`Версия ${next} уже установлена`);
const date=new Date().toISOString().slice(0,10);
const humanDate=new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
const escapeHtml=x=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let versionJs=read(VERSION_FILE).replace(VERSION_PATTERN,`APP_VERSION='${next}'`)
 .replace(/RELEASE_DATE\s*=\s*['"][^'"]+['"]/,`RELEASE_DATE='${date}'`);
write(VERSION_FILE,versionJs);
const packageJson=JSON.parse(read('package.json'));packageJson.version=next;write('package.json',JSON.stringify(packageJson,null,2)+'\n');
write('sw.js',read('sw.js').replace(/lokit-v\d+\.\d+\.\d+/,`lokit-v${next}`));
for(const p of PAGES){
 let html=read(p).replaceAll(`v${version}`,`v${next}`);
 if(p==='about.html'){
   html=html.replace(/<h2 id="release-title">[\s\S]*?<\/h2>/,`<h2 id="release-title">Версия <span data-app-version>v${next}</span> · предварительная</h2>`);
   html=html.replace(/<span class="subtle small">\d{1,2} [^<]+<\/span>/,`<span class="subtle small">${humanDate}</span>`);
   const listStart=html.indexOf('<ul class="release-list">');
   const listEnd=html.indexOf('</ul>',listStart);
   assert(listStart>=0&&listEnd>listStart,'Не найдена история изменений в about.html');
   html=html.slice(0,listStart)+`<ul class="release-list"><li>${escapeHtml(description)}</li></ul>`+html.slice(listEnd+5);
 }
 write(p,html);
}
const changelog=read('CHANGELOG.md');
write('CHANGELOG.md',changelog.startsWith('# ')
  ?changelog.replace(/^(#[^\n]*\n)/,`$1\n## v${next} — ${date}\n\n- ${description}\n`)
  :`## v${next} — ${date}\n\n- ${description}\n\n${changelog}`);
checkProject(next);
console.log(`Готов выпуск v${next}. Зафиксируйте изменения и отправьте тег v${next} для GitHub Release.`);
