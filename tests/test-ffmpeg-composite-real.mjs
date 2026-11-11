/** Run the actual FFmpeg/WASM worker command planner against real native FFmpeg.
 * The WebAssembly API is simulated only at the virtual FS / exec boundary:
 * all demux, filters, AAC encode, H.264 encode and MP4 mux happen for real.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=join(root,'tests','fixtures','generated');
const a=join(fixture,'h264-aac-faststart.mp4');
const b=join(fixture,'vp8-silent.webm');
assert.ok(existsSync(a)&&existsSync(b),'Run generate-media-fixtures.py first');
const runCmd=(program,args,cwd)=>{
  const p=spawnSync(program,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(p.status!==0)throw new Error(program+' failed: '+args.join(' ')+'\n'+(p.stderr||'').slice(-2800));
  return p.stdout;
};
const inspect=file=>JSON.parse(runCmd('ffprobe',['-v','error','-show_entries',
  'format=duration:stream=codec_name,codec_type,width,height','-of','json',file]));
const duration=x=>Number(x.format.duration);
const video=x=>x.streams.find(s=>s.codec_type==='video');
const audio=x=>x.streams.find(s=>s.codec_type==='audio');
const responses=[];
globalThis.self={postMessage(msg){responses.push(msg);},createFFmpegCore:null};
globalThis.importScripts=()=>{};
await import('../js/experimental-ffmpeg-worker.js');
const media=input=>({name:input.split('/').at(-1),bytes:Uint8Array.from(readFileSync(input)).buffer});
async function run(mode,inputs,options={}){
  const dir=mkdtempSync(join(tmpdir(),'lokit-ffmpeg-'));
  const core={
    ret:0,
    FS:{
      writeFile(name,data){writeFileSync(join(dir,name),new Uint8Array(data));},
      readFile(name){return new Uint8Array(readFileSync(join(dir,name)));}
    },
    exec(...args){
      const p=spawnSync('ffmpeg',args,{cwd:dir,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
      this.ret=p.status??1;
      if(this.ret!==0)console.error('FFmpeg diagnostic:',(p.stderr||'').slice(-800));
      return this.ret;
    }
  };
  self.createFFmpegCore=async()=>core;
  try{
    const prev=responses.length;
    await self.onmessage({data:{type:'run',mode,inputs:inputs.map(media),options,
      coreScriptUrl:'blob:core',wasmUrl:'blob:wasm'}});
    assert.equal(responses.length,prev+1);
    const result=responses.at(-1);
    assert.equal(result.type,'done',result.message||'No output');
    assert.equal(result.ext,'mp4');
    const output=join(dir,'result.mp4');
    writeFileSync(output,new Uint8Array(result.data));
    const p=inspect(output);
    assert.equal(video(p)?.codec_name,'h264');
    assert.ok(Math.abs(duration(p))>0);
    runCmd('ffmpeg',['-nostdin','-loglevel','error','-i',output,'-map','0:v:0','-f','null','-'],dir);
    if(audio(p))runCmd('ffmpeg',['-nostdin','-loglevel','error','-i',output,'-map','0:a:0','-f','null','-'],dir);
    return p;
  }finally{rmSync(dir,{recursive:true,force:true});}
}
const pa=inspect(a),pb=inspect(b);
let result=await run('merge',[a,b],{targetWidth:320,targetHeight:180});
assert.equal(audio(result)?.codec_name,'aac');
assert.ok(Math.abs(duration(result)-(duration(pa)+duration(pb)))<.4,'Merge must preserve both clip durations');
assert.equal(video(result).width,320);assert.equal(video(result).height,180);
result=await run('split',[a,b],{targetWidth:320,targetHeight:180,offsetSeconds:.5});
assert.equal(audio(result)?.codec_name,'aac','Split must keep first audio');
assert.ok(Math.abs(duration(result)-Math.max(duration(pa),duration(pb)+.5))<.4,'Split offset or duration wrong');
result=await run('vr',[a],{targetWidth:320,targetHeight:180});
assert.equal(audio(result)?.codec_name,'aac','VR should keep sound');
const image=Uint8Array.from(readFileSync(join(root,'icons','icon-192.png'))).buffer;
result=await run('watermark',[a],{watermarkPng:image,text:'Кириллица',resolution:'original'});
assert.equal(video(result)?.width,video(pa)?.width,'Watermark must preserve source geometry');
assert.equal(audio(result)?.codec_name,'aac','Watermark must preserve sound');
console.log('Native FFmpeg composite regression: incompatible merge with silent audio, split offset, VR, PNG watermark, full A/V decode — PASS');
