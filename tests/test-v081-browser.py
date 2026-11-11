"""End-to-end regression for editor/export linkage, run in Chromium CI."""
from pathlib import Path
import subprocess, time, os
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SERVER='http://127.0.0.1:8777'
server=subprocess.Popen(['python','-m','http.server','8777','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None,
                            args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  ctx=browser.new_context(accept_downloads=True)
  page=ctx.new_page()
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  sample=(ROOT/'tests/fixtures/sample.webm').read_bytes()
  def open_tool(name):
   page.goto(SERVER,wait_until='networkidle')
   page.locator('.tool-card').filter(has=page.locator('strong',has_text=name)).first.click()
  def two_files():
   page.locator('.studio-form input[type=file]').set_input_files([
     {'name':'first.webm','mimeType':'video/webm','buffer':sample},
     {'name':'second.webm','mimeType':'video/webm','buffer':sample}
   ])
  open_tool('Склеить видео');two_files()
  page.wait_for_function("() => document.querySelectorAll('.multi-timeline .multi-clip').length === 2",timeout=18000)
  assert page.locator('.multi-clip').nth(0).inner_text()=='first.webm'
  page.locator('[name=clipOrder]').select_option('reverse')
  assert page.locator('.multi-clip').nth(0).inner_text()=='second.webm'
  assert '05.000' in page.locator('.multi-total').inner_text()
  page.evaluate("""async()=>{const {tools}=await import('./js/tools.js');tools.find(t=>t.id==='video-merge').run=async({files,values})=>{
    window.__linkage={names:files.map(f=>f.name),order:values.clipOrder};return {blob:new Blob(['ok']),name:'join.webm'};
  }}""")
  page.locator('.studio-form button.primary').click()
  page.wait_for_function("()=> Boolean(window.__linkage)")
  assert page.evaluate('window.__linkage.order')=='reverse'

  open_tool('Разделённый экран');two_files()
  page.wait_for_function("() => document.querySelectorAll('.multi-timeline .multi-lane').length === 2",timeout=18000)
  page.locator('[name=offsetSeconds]').fill('0.7')
  page.wait_for_function("() => document.querySelector('.multi-clip-1')?.style.left !== '0%'",timeout=5000)
  assert '03.200' in page.locator('.multi-total').inner_text()
  page.evaluate("""async()=>{const {tools}=await import('./js/tools.js');tools.find(t=>t.id==='split-screen').run=async({values})=>{
    window.__splitOffset=values.offsetSeconds;return {blob:new Blob(['ok']),name:'split.webm'};
  }}""")
  page.locator('.studio-form button.primary').click()
  page.wait_for_function('()=>window.__splitOffset !== undefined')
  assert float(page.evaluate('window.__splitOffset'))==.7

  open_tool('Кадр из видео')
  page.locator('.studio-form input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.webm'))
  page.wait_for_function("()=>document.querySelector('.studio-player')?.duration>0",timeout=18000)
  page.locator('.studio-seek').fill('500')
  page.wait_for_function("()=>Number(document.querySelector('input[name=seconds]').value) > 1",timeout=8000)
  assert abs(float(page.locator('[name=seconds]').input_value())-1.25)<.2
  page.evaluate("""async()=>{const {tools}=await import('./js/tools.js');tools.find(t=>t.id==='video-frames').run=async({values})=>{
     window.__frameSeconds=values.seconds;return {blob:new Blob(['png']),name:'frame.png'};
  }}""")
  page.locator('.studio-form button.primary').click()
  page.wait_for_function('()=>window.__frameSeconds !== undefined')
  assert float(page.evaluate('window.__frameSeconds'))>1

  open_tool('SRT ⇄ VTT')
  page.locator('.studio-form input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.srt'))
  page.locator('.subtitle-cue-block').first.wait_for(state='visible',timeout=8000)
  old=page.locator('.studio-cue-timing input').first.input_value()
  page.locator('.subtitle-cue-block .subtitle-handle.start').first.focus()
  page.locator('.subtitle-cue-block .subtitle-handle.start').first.press('ArrowRight')
  assert page.locator('.studio-cue-timing input').first.input_value()!=old
  page.locator('[data-action=sub-undo]').click()
  assert page.locator('.studio-cue-timing input').first.input_value()==old

  open_tool('Запись камеры')
  page.evaluate("""()=>{
     const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;
     window.__captureStream=canvas.captureStream(12);
     const g=canvas.getContext('2d');window.__captureTimer=setInterval(()=>{g.fillStyle='#2d8fff';g.fillRect(0,0,canvas.width,canvas.height);},100);
     navigator.mediaDevices.getUserMedia=async()=>window.__captureStream;
  }""")
  page.locator('.studio-form button.primary').click()
  page.locator('.studio-capture-live').wait_for(state='visible',timeout=10000)
  assert page.locator('.studio-capture-live video').evaluate('(v)=>v.srcObject?.getVideoTracks().length===1')
  page.wait_for_timeout(650)
  page.locator('.studio-form button.danger').click()
  page.wait_for_function("()=>document.querySelector('#tool-status').textContent.includes('Готово')",timeout=12000)
  assert page.evaluate("window.__captureStream.getTracks().every(t=>t.readyState==='ended')")
  page.evaluate('clearInterval(window.__captureTimer)')
  assert page.locator('.studio-capture-live').is_hidden()
  # The new lossless routes must run inside an actual browser, independently
  # of the HTML player (headless Chromium may not decode every MP4 codec).
  page.goto(SERVER,wait_until='networkidle')
  routes=page.evaluate("""async () => {
    const {transformVideo,extractAudio}=await import('./js/media.js');
    const source=await fetch('./tests/fixtures/sample-audio.mp4').then(r=>r.blob())
      .then(b=>new File([b],'source.mp4',{type:'video/mp4'}));
    const webm=await fetch('./tests/fixtures/sample.webm').then(r=>r.blob())
      .then(b=>new File([b],'source.webm',{type:'video/webm'}));
    const loop=await transformVideo({files:[source],mode:'loop',options:{resolution:'original',loops:2}});
    const audio=await extractAudio(source);
    const convert=await transformVideo({files:[webm],mode:'convert',
      options:{resolution:'original',fps:'original',engine:'auto'}});
    return {loopMethod:loop.method,loopFast:loop.fast,loopBytes:loop.blob.size,
      audioMethod:audio.method,audioFast:audio.fast,audioType:audio.blob.type,
      convertMethod:convert.method,convertFast:convert.fast,convertSameBlob:convert.blob===webm};
  }""")
  assert routes['loopFast'] and routes['loopMethod']=='lossless-loop',routes
  assert routes['audioFast'] and routes['audioMethod']=='audio-remux',routes
  assert routes['audioType']=='audio/mp4',routes
  assert routes['convertFast'] and routes['convertMethod']=='copy',routes
  assert routes['convertSameBlob'],routes
  assert not errors,errors
  print('v0.8.1 browser + video fast paths: merge, split, frame, subtitles, capture, lossless loop/audio/convert — PASS')
  ctx.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
