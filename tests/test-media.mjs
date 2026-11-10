import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const base=path.dirname(fileURLToPath(import.meta.url));
const temp=path.join(base,'.tmp-modules');mkdirSync(temp,{recursive:true});
writeFileSync(path.join(temp,'render.mjs'),readFileSync(path.join(base,'..','js','render.js')));
writeFileSync(path.join(temp,'mp4-fast.mjs'),readFileSync(path.join(base,'..','js','mp4-fast.js')).toString().replace("'./vendor/mp4-track-remux.js'","'../vendor/mp4-track-remux.js'"));
writeFileSync(path.join(temp,'media.mjs'),readFileSync(path.join(base,'..','js','media.js'),'utf8').replace("'./render.js'","'./render.mjs'").replace("'./mp4-fast.js'","'./mp4-fast.mjs'"));
const {recordDevice,playbackWatchdog}=await import(pathToFileURL(path.join(temp,'media.mjs')).href);
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
// A stalled decoder must not spin forever, but normal playback, seeking and
// slow (but advancing) decoding must not trigger the watchdog.
let time=0;
const check=playbackWatchdog({maxIdleMs:15000,now:()=>time});
check(0);time=9000;check(0);
time=10000;check(0.04);
time=23000;check(0.04);
time=25001;
assert.throws(()=>check(0.04),/остановилось/);
const seekCheck=playbackWatchdog({maxIdleMs:1000,now:()=>time});
seekCheck(8);time+=700;seekCheck(8.05);time+=700;seekCheck(0.5);
time+=700;seekCheck(0.5);
assert.throws(()=>seekCheck(NaN),/некорректную/);
console.log('Media tests: recording abort, late camera cleanup and stalled-decoder guard — PASS');
