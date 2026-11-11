import assert from 'node:assert/strict';
import {experimentalEligibility,scaledSize,runWebCodecs,runFfmpeg,tryExperimental,DEPENDENCIES} from '../js/experimental-engines.js';
const file=new File([new Uint8Array(1024)],'phone.mov',{type:'video/quicktime'});
assert.equal(experimentalEligibility({files:[file],mode:'convert',options:{engine:'classic'}}).eligible,false);
assert.equal(experimentalEligibility({files:[file,file],mode:'convert',options:{engine:'ffmpeg'}}).eligible,false);
assert.equal(experimentalEligibility({files:[file],mode:'filter',options:{engine:'ffmpeg'}}).eligible,true);
assert.equal(experimentalEligibility({files:[file],mode:'merge',options:{engine:'ffmpeg'}}).eligible,false);
assert.equal(experimentalEligibility({files:[{name:'big.mp4',size:91*1024*1024}],mode:'compress',options:{engine:'ffmpeg'}}).eligible,false);
assert.deepEqual(scaledSize(1920,1080,'720'),{width:1280,height:720});
assert.deepEqual(scaledSize(1080,1920,'720'),{width:720,height:1280});
assert.deepEqual(scaledSize(640,360,'1080'),{width:640,height:360});
assert.deepEqual(scaledSize(1920,1080,'original'),{width:1920,height:1080});
class Input {
 constructor(){this.disposed=false;}
 async getVideoTracks(){return [{getDisplayWidth:async()=>1920,getDisplayHeight:async()=>1080}];}
 async getAudioTracks(){return [{id:'audio'}];}
 dispose(){this.disposed=true;}
}
class Output{constructor({target}){this.target=target;}}
class BufferTarget {constructor(){this.buffer=new Uint8Array([0,0,0,24,102,116,121,112]).buffer;}}
class Conversion{static discardedTracks=[];static utilizedTracks=[];static options=null;
 static async init(options){Conversion.options=options;return {isValid:true,discardedTracks:Conversion.discardedTracks,utilizedTracks:Conversion.utilizedTracks,onProgress:null,async execute(){this.onProgress?.(.5);}};}}
const fake={Input,Output,Conversion,ALL_FORMATS:[],BlobSource:class {},Mp4OutputFormat:class {},BufferTarget,Quality:class{}};
Conversion.utilizedTracks=[{},{}];
const seen=[];
const result=await runWebCodecs({file,mode:'convert',options:{resolution:'720'},mediabunny:fake,onProgress:x=>seen.push(x)});
assert.equal(result.method,'webcodecs');assert.equal(result.ext,'mp4');
assert.equal(Conversion.options.video.width,1280);assert.equal(Conversion.options.video.height,720);
assert.equal(Conversion.options.video.forceTranscode,undefined,'Plain conversion should use stream copy where possible');
assert.equal(Conversion.options.video.hardwareAcceleration,'prefer-hardware');
assert.equal(seen.some(x=>x.percent===50),true);
Conversion.utilizedTracks=[{}];
await assert.rejects(runWebCodecs({file,mode:'convert',options:{},mediabunny:fake}),/дорожки|WebCodecs/);
const WorkerImpl=class{
 constructor(){this.terminated=false;WorkerImpl.latest=this;}
 postMessage(data){assert.equal(data.mode,'compress');queueMicrotask(()=>this.onmessage({data:{type:'done',data:new Uint8Array([1,2,3,4]).buffer}}));}
 terminate(){this.terminated=true;}
};
const workerResult=await runFfmpeg({file,mode:'compress',options:{resolution:'720'},WorkerImpl,loadBlob:async(url)=>{
 assert(Object.values(DEPENDENCIES).includes(url));return new Blob([new Uint8Array([0])]);
 }});
assert.equal(workerResult.method,'ffmpeg-wasm');assert.equal(WorkerImpl.latest.terminated,true);
const c=new AbortController();c.abort();
await assert.rejects(runFfmpeg({file,mode:'convert',options:{},signal:c.signal,WorkerImpl,loadBlob:async()=>new Blob()}),{name:'AbortError'});
const before=globalThis.VideoEncoder;
try{
 delete globalThis.VideoEncoder;
 const fallback=await tryExperimental({files:[file],mode:'convert',options:{engine:'webcodecs'},onProgress:()=>{}});
 assert.equal(fallback,null);
}finally{if(before!==undefined)globalThis.VideoEncoder=before;}

// Auto policy must not fetch optional codecs just to start an export offline.
const previousEncoder=globalThis.VideoEncoder,previousDecoder=globalThis.VideoDecoder;
const previousCaches=globalThis.caches;
try{
  globalThis.VideoEncoder=class {};
  globalThis.VideoDecoder=class {};
  delete globalThis.caches;
  const eligible=experimentalEligibility({files:[file],mode:'compress',options:{engine:'auto'}});
  assert.equal(eligible.eligible,true);
  assert.equal(eligible.engine,'webcodecs');
  assert.equal(eligible.automatic,true);
  assert.equal(await tryExperimental({files:[file],mode:'compress',options:{engine:'auto'}}),null);
}finally{
  if(previousEncoder===undefined)delete globalThis.VideoEncoder;else globalThis.VideoEncoder=previousEncoder;
  if(previousDecoder===undefined)delete globalThis.VideoDecoder;else globalThis.VideoDecoder=previousDecoder;
  if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
}
console.log('Experimental engines: auto/offline policy, dimensions, audio-track guard, progress, FFmpeg isolation, cancel, fallback — PASS');
