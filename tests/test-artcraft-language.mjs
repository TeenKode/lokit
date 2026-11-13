import assert from 'node:assert/strict';
import {
 RUSSIAN_CATALOGS,NO_RUSSIAN_CATALOG,russianCatalogStatus,
 russianAppURL,setRussianStoredPreference,applyNativeRussian,supportsNativeLanguageCommand
} from '../js/craft-language.js';
import {readFileSync} from 'node:fs';

const releases=JSON.parse(readFileSync(new URL('../artcraft-releases.json',import.meta.url),'utf8'));
const names=releases.apps.map(x=>x.name);
assert.equal(names.length,15);
assert.equal(RUSSIAN_CATALOGS.size,12,'11 suite catalogs plus PdfCraft');
assert.equal(NO_RUSSIAN_CATALOG.size,4);
assert.deepEqual(new Set(names.filter(x=>russianCatalogStatus(x)==='missing')),NO_RUSSIAN_CATALOG);
assert.equal(names.filter(x=>russianCatalogStatus(x)==='available').length,11);
for(const name of names){
 const url=russianAppURL('https://example.test/lokit/craft-apps/'+name+'/',name);
 const parsed=new URL(url);
 assert.equal(parsed.pathname,'/lokit/craft-apps/'+name+'/');
 if(RUSSIAN_CATALOGS.has(name)){
   assert.equal(parsed.searchParams.get('lang'),'ru');
 }else{
   assert.equal(parsed.search,'','Apps without a Russian catalog cannot claim Russian');
 }
}
assert.equal(new URL(russianAppURL('https://example.test/lokit/pdfcraft/','pdfcraft')).searchParams.get('control'),'1');
assert.equal(new URL(russianAppURL('https://example.test/lokit/craft-apps/figcraft/','figcraft')).searchParams.get('control'),'1');
assert.equal(new URL(russianAppURL('https://example.test/lokit/craft-apps/photocraft/','photocraft')).searchParams.get('control'),null);
const data=new Map();
const storage={
 getItem(key){return data.get(key)??null;},
 setItem(key,value){data.set(key,value);}
};
storage.setItem('photocraft.preferences',JSON.stringify({
 interface:{language:'en',theme:'dark'},shortcuts:{save:'Ctrl+S'}
}));
assert.equal(setRussianStoredPreference('photocraft',storage),true);
const photo=JSON.parse(storage.getItem('photocraft.preferences'));
assert.equal(photo.interface.language,'ru');
assert.equal(photo.interface.theme,'dark');
assert.equal(photo.shortcuts.save,'Ctrl+S');
assert.equal(setRussianStoredPreference('photocraft',storage),true);
assert.equal(setRussianStoredPreference('wordcraft',storage),true);
assert.equal(JSON.parse(storage.getItem('wordcraft.ui')).language,'ru');
storage.setItem('gridcraft.ui','{"language":"fr","theme":"dark","other":8}');
assert.equal(setRussianStoredPreference('gridcraft',storage),true);
assert.equal(JSON.parse(storage.getItem('gridcraft.ui')).other,8);
assert.equal(JSON.parse(storage.getItem('gridcraft.ui')).language,'ru');
data.set('photocraft.preferences','{broken JSON');
assert.equal(setRussianStoredPreference('photocraft',storage),false,'Must preserve corrupted prefs');
assert.equal(storage.getItem('photocraft.preferences'),'{broken JSON');
assert.equal(setRussianStoredPreference('soundcraft',storage),false);

const expected={
 pdfcraft:['request','ui.set',{key:'language',value:'ru'}],
 wordcraft:['execute','ui.language',{value:'ru'}],
 gridcraft:['execute','app.language.set',{language:'ru'}],
 cadcraft:['execute','ui.language',{lang:'ru'}],
 filmcraft:['execute','prefs.set',{key:'general.interfaceLanguage',value:'ru'}],
 effectcraft:['execute','prefs.set',{key:'general.language',value:'ru'}],
 vectorcraft:['execute','app.language',{lang:'ru'}],
 figcraft:['execute','pref.language',{language:'ru'}]
};
for(const [name,[method,command,params]] of Object.entries(expected)){
 assert.equal(supportsNativeLanguageCommand(name),true);
 let hits=0;
 const window={[name]:{[method]:async(cmd,data)=>{
   hits++;
   assert.equal(cmd,command);
   assert.deepEqual(data,params);
   return {ok:true};
 }}};
 assert.equal(await applyNativeRussian(window,name,{attempts:2,sleep:async()=>{}}),true,name);
 assert.equal(hits,1,name);
}
let attempts=0;
const awaiting={pdfcraft:{request:async()=>{attempts++;if(attempts<2)throw Error('Starting');}}};
assert.equal(await applyNativeRussian(awaiting,'pdfcraft',{attempts:3,sleep:async()=>{}}),true);
assert.equal(attempts,2);
assert.equal(await applyNativeRussian({},'pdfcraft',{attempts:2,sleep:async()=>{}}),false);
assert.equal(await applyNativeRussian({},'soundcraft',{attempts:2,sleep:async()=>{}}),false);
console.log('ArtCraft Russian locale: source-supported catalog coverage, safe stored preferences, URL flags and 8 native control commands — PASS');
