import assert from 'node:assert/strict';
// Exercise the actual classic worker command builder with a virtual FFmpeg core.
// CI also validates decoded real video files independently in test-formats.py.
const responses=[],executions=[];
const core={
  ret:0,
  FS:{writeFile(name,data){assert.ok(name.startsWith('input.'));assert.ok(data.byteLength);},
    readFile(name){assert.ok(name.endsWith('.mp4')||name.endsWith('.m4a')||name.endsWith('.png'));return new Uint8Array([1,2,3,4]);}},
  exec(...args){executions.push(args);return 0;}
};
globalThis.self={createFFmpegCore:async()=>core,postMessage(message){responses.push(message);}};
globalThis.importScripts=()=>{};
await import('../js/experimental-ffmpeg-worker.js');
async function run(mode,options={},name='sample.mkv'){
  const before=executions.length;
  await self.onmessage({data:{type:'run',mode,options,name,bytes:new Uint8Array([4,5,6]).buffer,
    coreScriptUrl:'blob:ffmpeg',wasmUrl:'blob:wasm'}});
  const message=responses.at(-1);
  assert.equal(message.type,'done',JSON.stringify(message));
  assert.equal(executions.length,before+1);
  return {args:executions.at(-1),ext:message.ext};
}
const has=(args,token)=>args.some(a=>String(a).includes(token));
let p=await run('convert',{resolution:'original',fps:'original'});
assert.equal(p.ext,'mp4');
assert.ok(has(p.args,'libx264')&&has(p.args,'yuv420p')&&has(p.args,'0:a?'));
assert.ok(!has(p.args,'-r'),'Do not change native FPS unless requested');
p=await run('convert',{resolution:'720',fps:'25'});
assert.ok(has(p.args,'scale=')&&has(p.args,'-r')&&has(p.args,'25'));
p=await run('compress',{bitrate:650000,resolution:720});
assert.ok(has(p.args,'-b:v')&&has(p.args,'650000'));
p=await run('trim',{start:.4,end:1.8});
assert.ok(has(p.args,'-ss')&&has(p.args,'-t')&&has(p.args,'1.4'));
p=await run('mute');
assert.ok(has(p.args,'-an')&&!has(p.args,'-c:a'));
p=await run('speed',{speed:.25});
assert.ok(has(p.args,'setpts=PTS/0.25')&&has(p.args,'atempo=0.5,atempo=0.5'));
p=await run('loop',{loops:3});
assert.ok(has(p.args,'-stream_loop')&&has(p.args,'2'));
p=await run('crop',{crop:15});
assert.ok(has(p.args,'crop='));
p=await run('flip-h');
assert.ok(has(p.args,'hflip'));
p=await run('rotate-270');
assert.ok(has(p.args,'transpose=2'));
p=await run('filter',{filter:'grayscale(1)'});
assert.ok(has(p.args,'hue=s=0'));
p=await run('blur',{blur:9});
assert.ok(has(p.args,'boxblur=9:1'));
p=await run('volume',{gain:1.5});
assert.ok(has(p.args,'volume=1.5'));
p=await run('extract-audio');
assert.equal(p.ext,'m4a');
assert.ok(has(p.args,'0:a:0')&&has(p.args,'192k')&&!has(p.args,'libx264'));
p=await run('frame',{seconds:3.25});
assert.equal(p.ext,'png');
assert.ok(has(p.args,'-ss')&&has(p.args,'3.25')&&has(p.args,'-frames:v'));
const before=executions.length;
await self.onmessage({data:{type:'run',mode:'filter',options:{filter:'arbitrary;command'},
  name:'input.mkv',bytes:new Uint8Array([1,2]).buffer}});
assert.equal(responses.at(-1).type,'error');
assert.equal(executions.length,before,'Reject unsupported filters before FFmpeg execution');
console.log('FFmpeg compatibility worker: input formats, transform filters, audio, frame, output codec, safe options — PASS');
