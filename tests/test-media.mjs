import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const base=path.dirname(fileURLToPath(import.meta.url));
const temp=path.join(base,'.tmp-modules');mkdirSync(temp,{recursive:true});
writeFileSync(path.join(temp,'render.mjs'),readFileSync(path.join(base,'..','js','render.js')));
writeFileSync(path.join(temp,'mp4-fast.mjs'),readFileSync(path.join(base,'..','js','mp4-fast.js')).toString().replace("'./vendor/mp4-track-remux.js'","'../vendor/mp4-track-remux.js'"));
writeFileSync(path.join(temp,'codec-assets.js'),readFileSync(path.join(base,'..','js','codec-assets.js')));
writeFileSync(path.join(temp,'experimental-engines.mjs'),readFileSync(path.join(base,'..','js','experimental-engines.js')));
writeFileSync(path.join(temp,'media.mjs'),readFileSync(path.join(base,'..','js','media.js'),'utf8').replace("'./render.js'","'./render.mjs'").replace("'./mp4-fast.js'","'./mp4-fast.mjs'").replace("'./experimental-engines.js'","'./experimental-engines.mjs'"));
const {recordDevice,playbackWatchdog,awaitMedia,splitPlaybackWatchdog,openVideo}=await import(pathToFileURL(path.join(temp,'media.mjs')).href);
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
assert.throws(()=>check(0.04),/перестал воспроизводить/);
const seekCheck=playbackWatchdog({maxIdleMs:1000,now:()=>time});
seekCheck(8);time+=700;seekCheck(8.05);time+=700;seekCheck(0.5);
time+=700;seekCheck(0.5);
assert.throws(()=>seekCheck(NaN),/Не удалось определить положение/);
console.log('Media tests: recording abort, late camera cleanup and stalled-decoder guard — PASS');

const errorWait=new AbortController();
const deferred=Promise.withResolvers();
const waiting=awaitMedia(deferred.promise,{signal:errorWait.signal,timeoutMs:5000});
errorWait.abort();
await assert.rejects(waiting,{name:'AbortError'});
deferred.reject(new Error('Late media failure'));
await new Promise(resolve=>setTimeout(resolve,0)); // No unhandled rejection.
await assert.rejects(awaitMedia(new Promise(()=>{}),{timeoutMs:25,message:'Decoder timeout'}),/Decoder timeout/);
let tick=0;
const checkSplit=splitPlaybackWatchdog({maxIdleMs:1000,now:()=>tick});
const a={currentTime:0,ended:false},b={currentTime:0,ended:false};
checkSplit({primary:a,secondary:b,secondStarted:true});
tick=600;a.currentTime=.4;checkSplit({primary:a,secondary:b,secondStarted:true});
tick=1400;a.currentTime=.9;
assert.throws(()=>checkSplit({primary:a,secondary:b,secondStarted:true}),/перестал воспроизводить/);
const checks={stopped:0};
const newStream=()=>{const tracks=[{stop(){checks.stopped++;},addEventListener(){}},{stop(){checks.stopped++;},addEventListener(){}}];return {getTracks:()=>tracks,getAudioTracks:()=>[tracks[1]],getVideoTracks:()=>[tracks[0]]};};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>newStream()}}});
let mode='stop';
class BrokenRecorder{
  static isTypeSupported(){return true;}
  constructor(_stream,{mimeType}={}){this.state='inactive';this.mimeType=mimeType||'video/webm';this.callbacks=new Map();}
  addEventListener(type,cb){const a=this.callbacks.get(type)||[];a.push(cb);this.callbacks.set(type,a);}
  emit(type,value={}){for(const cb of this.callbacks.get(type)||[])cb(value);}
  start(){this.state='recording';queueMicrotask(()=>{if(mode==='error')this.emit('error',{error:new Error('Encoder disconnected')});else this.stop();});}
  stop(){if(this.state!=='recording')return;this.state='inactive';this.emit('stop');}
}
globalThis.MediaRecorder=BrokenRecorder;
for(const type of ['stop','error']){
  mode=type;let cleared=0;
  await assert.rejects(recordDevice('webcam',{onStream:stream=>{if(stream===null)cleared++;}}),
    type==='stop'?/Запись прервалась/:/Encoder disconnected/);
  assert.equal(cleared,1,'Camera preview must be cleared after recorder exit');
}
assert.equal(checks.stopped,4,'Both media tracks must stop after each recorder failure');
// Failure while reading metadata must stop the decoder, clear src and revoke its URL.
const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
let video,released=0;
class BrokenVideo{
  constructor(){video=this;this.style={};this.listeners=new Map();}
  addEventListener(type,fn){(this.listeners.get(type)||this.listeners.set(type,[]).get(type)).push(fn);}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(f=>f!==fn));}
  load(){if(this.src)queueMicrotask(()=>{for(const fn of this.listeners.get('error')||[])fn();});}
  pause(){this.paused=true;}
  removeAttribute(name){if(name==='src')this.src='';}
  remove(){this.removed=true;}
}
globalThis.document={createElement:()=>new BrokenVideo(),body:{append(){}}};
URL.createObjectURL=()=> 'blob:broken';
URL.revokeObjectURL=()=>{released++;};
await assert.rejects(openVideo(new File([new Uint8Array([0])],'corrupt.mp4')),/не поддерживает|повреждён/);
assert.equal(video.paused,true);assert.equal(video.src,'');assert.equal(video.removed,true);assert.equal(released,1);
URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;
console.log('Media reliability: abort/timeout, split decoder stall, recorder stop/error and video cleanup — PASS');
