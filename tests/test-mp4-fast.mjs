import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

// The supplied MP4 remuxer uses the browser global. Test its JS implementation
// with Node's native File/Blob APIs, without stubs for the MP4 data.
globalThis.window=globalThis;
const folder=dirname(fileURLToPath(import.meta.url));
const samples=join(folder,'fixtures');
const file=(name)=>new File([readFileSync(join(samples,name))],name,{type:'video/mp4'});
const source=file('sample-audio.mp4'),silent=file('sample-silent.mp4');
const {tryFastMp4}=await import('../js/mp4-fast.js');
const report=[];
const mute=await tryFastMp4({file:source,mode:'mute',options:{resolution:'original'},onProgress:p=>report.push(p)});
assert.equal(mute.ext,'mp4');
assert.equal(mute.fast,true);
assert.equal(mute.method,'track-remux');
assert.equal(report.at(-1).percent,100);
const engine=globalThis.MP4TrackRemux;
const before=await engine.inspect(source);
const muted=await engine.inspect(new File([mute.blob],'muted.mp4',{type:'video/mp4'}));
assert.equal(before.tracks.filter(x=>x.handler==='soun').length,1);
assert.equal(muted.tracks.filter(x=>x.handler==='soun').length,0);
assert.equal(muted.tracks.find(x=>x.handler==='vide').codec,before.tracks.find(x=>x.handler==='vide').codec);
assert.ok(Math.abs(muted.durationSec-before.durationSec)<.08);
assert.ok(mute.blob.size>100);
const fastAlreadySilent=await tryFastMp4({file:silent,mode:'mute',options:{resolution:'original'}});
assert.equal(fastAlreadySilent.blob,silent);
const beforeSilent=await engine.inspect(silent);
const speed=await tryFastMp4({file:silent,mode:'speed',options:{resolution:'original',speed:'2'}});
assert.equal(speed.fast,true);
assert.equal(speed.method,'timestamp-retime');
const afterSpeed=await engine.inspect(new File([speed.blob],'speed.mp4',{type:'video/mp4'}));
assert.ok(Math.abs(afterSpeed.durationSec-beforeSilent.durationSec/2)<.08,`${afterSpeed.durationSec} vs ${beforeSilent.durationSec}`);
// Lossless accurate MP4 cut retains both tracks and reports a one-second range.
const cut=await tryFastMp4({file:source,mode:'trim',options:{resolution:'original',start:0.25,end:1.25,cutMode:'exact'}});
assert.equal(cut.fast,true);
assert.equal(cut.method,'lossless-trim');
const cutMeta=await (await (async()=>{await import('../js/vendor/mp4-flatten.js');await import('../js/vendor/mp4-copy-trim.js');return globalThis.Mp4CopyTrim;})()).inspect(new File([cut.blob],'cut.mp4',{type:'video/mp4'}));
assert.ok(Math.abs(cut.blob.trimInfo.durationMs-1000)<75,cut.blob.trimInfo.durationMs);
assert.equal(cutMeta.tracks.filter(x=>x.handler==='soun').length,1);
const joined=await tryFastMp4({files:[source,source],mode:'merge',options:{resolution:'original'}});
assert.equal(joined.fast,true);
assert.equal(joined.method,'lossless-merge');
const joinedMeta=await globalThis.Mp4CopyTrim.inspect(new File([joined.blob],'joined.mp4',{type:'video/mp4'}));
assert.ok(Math.abs(joinedMeta.durationMs-3000)<90,joinedMeta.durationMs);
const webm=new File([readFileSync(join(samples,'sample.webm'))],'sample.webm',{type:'video/webm'});
const webmCut=await tryFastMp4({file:webm,mode:'trim',options:{resolution:'original',start:0,end:1.2,cutMode:'exact'}});
assert.equal(webmCut.fast,true);
assert.equal(webmCut.ext,'webm');
assert.ok(webmCut.blob.size>500);
assert.equal(await tryFastMp4({file:webm,mode:'trim',options:{resolution:'original',start:.2,end:1.2,cutMode:'exact'}}),null,'Accurate WebM trim must not start earlier than requested');
const keyframeCut=await tryFastMp4({file:webm,mode:'trim',options:{resolution:'original',start:.2,end:1.2,cutMode:'keyframe'}});
assert.equal(keyframeCut.fast,true);
assert.ok(keyframeCut.info.includes('ключевого'),keyframeCut.info);
assert.equal(await tryFastMp4({file:source,mode:'speed',options:{resolution:'original',speed:2}}),null,'No audio dropping with speed');
assert.equal(await tryFastMp4({file:source,mode:'mute',options:{resolution:720}}),null,'Resolution change must trigger reencode');
assert.equal(await tryFastMp4({file:source,mode:'crop',options:{resolution:'original'}}),null);
const ctl=new AbortController();ctl.abort();
await assert.rejects(()=>tryFastMp4({file:source,mode:'mute',options:{resolution:'original'},signal:ctl.signal}),{name:'AbortError'});

const originalWarn=console.warn;console.warn=()=>{};
try{
  const corrupted=[
    new File([new Uint8Array(128).fill(255)],'corrupt.mp4',{type:'video/mp4'}),
    new File([readFileSync(join(samples,'sample-audio.mp4')).subarray(0,128)],'truncated.mp4',{type:'video/mp4'}),
    new File([new Uint8Array(80)],'corrupt.webm',{type:'video/webm'}),
    new File([readFileSync(join(samples,'sample.webm')).subarray(0,64)],'truncated.webm',{type:'video/webm'}),
    new File([readFileSync(join(samples,'sample.webm'))],'wrong.mp4',{type:'video/mp4'})
  ];
  for(const file of corrupted){
    const result=await tryFastMp4({file,files:[file],mode:'trim',options:{resolution:'original',start:.1,end:.8,cutMode:'keyframe'}});
    assert.equal(result,null,'Corrupt or mislabeled media must not be reported as successful');
  }
}finally{console.warn=originalWarn;}

// Codec/geometry probes work from container atoms, without an HTML decoder.
const {inspectContainer}=await import('../js/mp4-fast.js');
const sourceInfo=await inspectContainer(source);
assert.equal(sourceInfo.videoCodec,'h264');
assert.equal(sourceInfo.audioCodec,'aac');
assert.ok(sourceInfo.duration>0 && sourceInfo.width>0 && sourceInfo.height>0);
const webmInfo=await inspectContainer(webm);
assert.match(webmInfo.videoCodec,/V_VP[89]/);
assert.ok(webmInfo.duration>0);
assert.equal(await inspectContainer(new File([new Uint8Array([1,2,3])],'record.avi')),null);

// Repeat MP4 through the same zero-copy concatenation as merge, preserving audio.
const repeated=await tryFastMp4({file:source,mode:'loop',options:{resolution:'original',loops:3}});
assert.equal(repeated.fast,true);
assert.equal(repeated.method,'lossless-loop');
const repeatedMeta=await globalThis.Mp4CopyTrim.inspect(new File([repeated.blob],'repeated.mp4',{type:'video/mp4'}));
assert.ok(Math.abs(repeatedMeta.durationMs-before.durationSec*3000)<250,'Repeated duration must match source × 3');
assert.equal(repeatedMeta.tracks.filter(x=>x.handler==='soun').length,1,'Loop must preserve audio');
const silentRepeated=await tryFastMp4({file:silent,mode:'loop',options:{resolution:'original',loops:2}});
assert.equal(silentRepeated.method,'lossless-loop');
const silentMeta=await globalThis.Mp4CopyTrim.inspect(new File([silentRepeated.blob],'silent-loop.mp4',{type:'video/mp4'}));
assert.equal(silentMeta.tracks.filter(x=>x.handler==='soun').length,0);
assert.equal(await tryFastMp4({file:source,mode:'loop',options:{resolution:'original',loops:11}}),null);

// Avoid unnecessary encoding in no-op processing modes.
for(const [mode,options] of [
  ['volume',{gain:1}],['crop',{crop:0}],['blur',{blur:0}],
  ['speed',{speed:1}],['loop',{loops:1}]
]){
  const result=await tryFastMp4({file:source,mode,options:{resolution:'original',...options}});
  assert.equal(result?.blob,source,`${mode} should reuse the original file`);
  assert.equal(result.method,'copy');
}
assert.equal((await tryFastMp4({file:webm,mode:'loop',options:{resolution:'original',loops:1}})).blob,webm);
assert.equal(await tryFastMp4({file:source,mode:'volume',options:{gain:1,audio:'off'}}),null);

// Avoid re-encoding an already sufficiently small video in the compressor.
const smallEnough=await tryFastMp4({file:source,mode:'compress',options:{resolution:'original',bitrate:'650000'}});
assert.equal(smallEnough?.blob,source);
assert.equal(smallEnough?.method,'copy');
assert.equal(await tryFastMp4({file:source,mode:'compress',options:{resolution:'original',bitrate:'100'}}),null);
assert.equal(await tryFastMp4({file:source,mode:'compress',options:{resolution:'720',bitrate:'650000'}}),null);
assert.equal((await tryFastMp4({file:webm,mode:'compress',options:{resolution:'original',bitrate:'650000'}}))?.blob,webm);

// Preserve AAC without decoding, with a real M4A container and no video tracks.
const {tryFastExtractAudio}=await import('../js/mp4-fast.js');
const extracted=await tryFastExtractAudio({file:source});
assert.equal(extracted?.fast,true);
assert.equal(extracted?.ext,'m4a');
assert.equal(extracted?.method,'audio-remux');
const audioMeta=await engine.inspect(new File([extracted.blob],'extracted.m4a',{type:'audio/mp4'}));
assert.equal(audioMeta.tracks.filter(t=>t.handler==='vide').length,0);
assert.equal(audioMeta.tracks.filter(t=>t.handler==='soun').length,1);
assert.equal(audioMeta.tracks.find(t=>t.handler==='soun').codec,before.tracks.find(t=>t.handler==='soun').codec);
assert.equal(await tryFastExtractAudio({file:silent}),null,'Silent video has no soundtrack to copy');
const abortedAudio=new AbortController();abortedAudio.abort();
await assert.rejects(()=>tryFastExtractAudio({file:source,signal:abortedAudio.signal}),{name:'AbortError'});
const fakeMp4=new File([new Uint8Array(128).fill(255)],'broken.mp4',{type:'video/mp4'});
assert.equal(await tryFastExtractAudio({file:fakeMp4}),null,'Corrupt MP4 must not yield fake M4A');

console.log('Lossless MP4/WebM: trim, join, loop, audio extraction, no-op copy, mute, retime, keyframe guardrails, abort — PASS');
