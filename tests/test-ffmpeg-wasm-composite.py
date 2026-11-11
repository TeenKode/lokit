"""Real bundled FFmpeg/WASM smoke test in Chromium (not native FFmpeg mocks).

Exercises actual Emscripten decoding, filtering, H.264/AAC encoding and MP4
muxing through the same two-input Worker used by the application.
"""
from pathlib import Path
import subprocess,sys,time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SERVER=subprocess.Popen([sys.executable,'-m','http.server','8793','--bind','127.0.0.1',
                         '--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as playwright:
  browser=playwright.chromium.launch(headless=True,args=['--no-sandbox'])
  page=browser.new_page()
  errors=[];messages=[]
  page.on('pageerror',lambda err: errors.append(str(err)))
  page.on('console',lambda msg:messages.append(msg.text))
  page.goto('http://127.0.0.1:8793/',wait_until='domcontentloaded')
  try:
   result=page.evaluate("""async () => {
      const {runFfmpeg}=await import('/js/experimental-engines.js');
      const {inspectContainer}=await import('/js/mp4-fast.js');
      const from=async(path,name,type)=>{
        const response=await fetch(path);if(!response.ok)throw Error(path+' HTTP '+response.status);
        return new File([await response.arrayBuffer()],name,{type});
      };
      const mp4=await from('/tests/fixtures/sample-audio.mp4','first.mp4','video/mp4');
      const webm=await from('/tests/fixtures/sample.webm','second.webm','video/webm');
      const watermarkPng=await (await fetch('/icons/icon-192.png')).arrayBuffer();
      const cases=[
        {mode:'merge',files:[mp4,webm],options:{resolution:'original',targetWidth:320,targetHeight:180}},
        {mode:'split',files:[mp4,webm],options:{resolution:'original',targetWidth:320,targetHeight:180,offsetSeconds:0.3}},
        {mode:'watermark',files:[mp4],options:{resolution:'original',watermarkPng,text:'Тест'}},
        {mode:'vr',files:[mp4],options:{resolution:'original',targetWidth:320,targetHeight:180}}
      ];
      const outcomes=[];
      for(const item of cases){
        const progress=[];
        const start=performance.now();
        const r=await runFfmpeg({...item,onProgress:p=>{
          if(p.stage==='processing')progress.push(p.percent);
        }});
        if(r.method!=='ffmpeg-wasm'||r.ext!=='mp4'||r.blob.size<1000)
          throw Error(item.mode+': missing actual FFmpeg MP4 output');
        const meta=await inspectContainer(new File([r.blob],item.mode+'.mp4',{type:'video/mp4'}));
        if(!meta || meta.videoCodec!=='h264'||meta.audioCodec!=='aac'||meta.duration<=0)
          throw Error(item.mode+': invalid H.264/AAC tracks '+JSON.stringify(meta));
        if(item.mode==='merge'&&meta.duration<2)throw Error('merge: unexpected duration '+meta.duration);
        outcomes.push({mode:item.mode,bytes:r.blob.size,duration:meta.duration,
          width:meta.width,height:meta.height,elapsedMs:Math.round(performance.now()-start)});
      }
      return outcomes;
   }""")
   assert [x['mode'] for x in result]==['merge','split','watermark','vr'],result
   assert not errors,errors
   print('PASS: real bundled FFmpeg/WASM composite pipelines (Chromium):',result)
  except Exception:
   print('WASM composite browser logs:',messages[-16:])
   print('WASM composite page errors:',errors)
   raise
  finally:
   browser.close()
finally:
 SERVER.terminate()
 SERVER.wait(timeout=5)
