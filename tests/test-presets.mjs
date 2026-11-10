import assert from 'node:assert/strict';
import {readPreset,savePreset,applyPreset,resetPreset} from '../js/presets.js';
const store=new Map();
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
const tool={id:'video-trim',options:[
 {key:'start',type:'number',default:'0',min:0,max:999},
 {key:'end',type:'number',default:'0',min:0,max:999},
 {key:'width',type:'select',default:'720',choices:[['720','HD'],['1080','Full HD']]}
]};
const fields={start:{value:'2.5',dispatchEvent(){}},end:{value:'6.3',dispatchEvent(){}},width:{value:'1080',dispatchEvent(){}}};
const form={elements:{namedItem:key=>fields[key]}};
assert.equal(savePreset(tool,form),true);
assert.deepEqual(readPreset(tool),{start:'2.5',end:'6.3',width:'1080'});
fields.start.value='0';fields.end.value='0';fields.width.value='720';
assert.equal(applyPreset(tool,form),3);
assert.equal(fields.start.value,'2.5');assert.equal(fields.width.value,'1080');
assert.equal(store.size,1,'Only settings should be stored, never filenames');
resetPreset(tool,form);
assert.equal(fields.start.value,'0');assert.equal(fields.width.value,'720');
assert.deepEqual(readPreset(tool),{});
store.set('lokit:tool-settings:v1:video-trim',JSON.stringify({start:'2000',width:'invalid',unknown:'secret'}));
assert.equal(applyPreset(tool,form),0,'Invalid and unknown options are ignored');
console.log('Presets: save, restore, reset, validation, no file data — PASS');
