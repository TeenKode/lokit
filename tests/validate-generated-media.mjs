/** Run the same lossless MP4/WebM path as the browser against FFmpeg fixtures.
 * Results are validated independently by ffprobe/ffmpeg in test-formats.py.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join,basename,extname} from 'node:path';

globalThis.window=globalThis;
const root=join(dirname(fileURLToPath(import.meta.url)),'fixtures','generated');
const dir=join(root,'results');mkdirSync(dir,{recursive:true});
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const {tryFastMp4}=await import('../js/mp4-fast.js');
const file=(name)=>new File([readFileSync(join(root,name))],name,{type:name.endsWith('.webm')?'video/webm':name.endsWith('.mov')?'video/quicktime':'video/mp4'});
let result=[];
async function execute(name,mode,options,files){
  const input=files||[file(name)];
  let output=null,error=null;
  try {output=await tryFastMp4({files:input,file:input[0],mode,options});}
  catch(e){error=e.message;}
  const record={input:name,mode,options,fast:!!output,error};
  if(output){
    assert.equal(output.fast,true);
    assert.ok(output.blob.size>100,`Empty file: ${name}`);
    const outName=`${String(result.length).padStart(2,'0')}-${mode}-${basename(name,extname(name))}.${output.ext}`;
    writeFileSync(join(dir,outName),Buffer.from(await output.blob.arrayBuffer()));
    record.file=outName;
    record.method=output.method;
    record.trimInfo=output.blob.trimInfo;
  }
  result.push(record);
  return output;
}
const READY=new Set(manifest.filter(x=>x.status==='ready').map(x=>x.file));
for(const name of READY){
  if(name.endsWith('.mp4')){
    const cut=await execute(name,'trim',{resolution:'original',start:0.45,end:1.55,cutMode:'exact'});
    assert.ok(cut,`Expected lossless trim for ${name}`);
    const muted=await execute(name,'mute',{resolution:'original'});
    assert.ok(muted,`Expected lossless mute for ${name}`);
  }else if(name.endsWith('.webm')){
    await execute(name,'trim',{resolution:'original',start:0.45,end:1.55,cutMode:'exact'});
    const approximate=await execute(name,'trim',{resolution:'original',start:0.45,end:1.55,cutMode:'keyframe'});
    assert.ok(approximate,`Expected approximate keyframe trim for ${name}`);
  }
}
// Verify genuine QuickTime H.264/AAC with real FFmpeg decode, not just extension matching.
if(READY.has('h264-mov.mov')){
  const name='h264-mov.mov';
  assert.ok(await execute(name,'trim',{resolution:'original',start:.45,end:1.55,cutMode:'exact'}));
  assert.ok(await execute(name,'mute',{resolution:'original'}));
  assert.ok(await execute(name,'convert',{resolution:'original',fps:'original',engine:'auto'}));
  assert.ok(await execute(name,'loop',{resolution:'original',loops:2}));
}
if(READY.has('h264-silent.mp4')){
  const speed=await execute('h264-silent.mp4','speed',{resolution:'original',speed:1.5});
  assert.ok(speed);
}
const doubles=['h264-aac-faststart.mp4','h264-aac-bframes.mp4','h264-aac-2997.mp4','h264-fragmented.mp4','h264-aac-60fps.mp4'];
for(const name of doubles){
  if(!READY.has(name))continue;
  const joined=await execute(name,'merge',{resolution:'original'},[file(name),file(name)]);
  assert.ok(joined,`Expected lossless join for identical ${name}`);
}
if(READY.has('h264-aac-faststart.mp4')&&READY.has('h264-alt-res.mp4')){
  const mismatch=await execute('h264-aac-faststart.mp4','merge',{resolution:'original'},[file('h264-aac-faststart.mp4'),file('h264-alt-res.mp4')]);
  assert.equal(mismatch,null,'Different dimensions must not fast-merge');
}
if(READY.has('h264-aac-faststart.mp4')&&READY.has('h264-silent.mp4')){
  const mismatch=await execute('h264-aac-faststart.mp4','merge',{resolution:'original'},[file('h264-aac-faststart.mp4'),file('h264-silent.mp4')]);
  assert.equal(mismatch,null,'Audio mismatch must not fast-merge');
}
if(READY.has('h264-aac-faststart.mp4')&&READY.has('mpeg4-aac.mp4')){
  const mismatch=await execute('h264-aac-faststart.mp4','merge',{resolution:'original'},[file('h264-aac-faststart.mp4'),file('mpeg4-aac.mp4')]);
  assert.equal(mismatch,null,'Video codec mismatch must not fast-merge');
}
const invalid=new File([new Uint8Array(256).fill(2)],'corrupted.mp4',{type:'video/mp4'});
const bad=await tryFastMp4({files:[invalid],mode:'trim',options:{resolution:'original',start:0,end:1}});
assert.equal(bad,null,'Broken file should fall back instead of being advertised as fast');
writeFileSync(join(root,'results.json'),JSON.stringify(result,null,2));
console.log(`Container engine: ${result.length} scenarios, ${result.filter(x=>x.fast).length} fast outputs, unsupported cases safely rejected`);
