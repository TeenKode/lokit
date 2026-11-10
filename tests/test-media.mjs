import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const base=path.dirname(fileURLToPath(import.meta.url));
const temp=path.join(base,'.tmp-modules');mkdirSync(temp,{recursive:true});
writeFileSync(path.join(temp,'render.mjs'),readFileSync(path.join(base,'..','js','render.js')));
writeFileSync(path.join(temp,'media.mjs'),readFileSync(path.join(base,'..','js','media.js'),'utf8').replace("'./render.js'","'./render.mjs'"));
const {recordDevice}=await import(pathToFileURL(path.join(temp,'media.mjs')).href);
let resolvePermission;
const streamPromise=new Promise(resolve=>{resolvePermission=resolve;});
let tracksStopped=0;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{
  mediaDevices:{getUserMedia:()=>streamPromise}
}});
const controller=new AbortController();
const operation=recordDevice('webcam',{signal:controller.signal});
controller.abort();
await assert.rejects(operation,{name:'AbortError'});
resolvePermission({getTracks:()=>[{stop:()=>{tracksStopped++;}},{stop:()=>{tracksStopped++;}}]});
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(tracksStopped,2,'Late-granted camera tracks must be stopped after cancellation');
console.log('Media tests: immediate capture cancellation and late camera permission cleanup — PASS');
