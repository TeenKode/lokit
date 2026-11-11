"""Chromium smoke of VP8 WebM and H.264 MP4 generated on the runner."""
from pathlib import Path
import os, shutil, subprocess, tempfile, time
from playwright.sync_api import sync_playwright
from sidebar_nav import click_sidebar_tool
ROOT=Path(__file__).resolve().parents[1]
if not shutil.which('ffmpeg'):
 print('SKIPPED codec generation: ffmpeg not installed')
 raise SystemExit(0)
with tempfile.TemporaryDirectory() as temp:
 directory=Path(temp)
 sources=[('vp8.webm',['-c:v','libvpx','-b:v','600k']),('h264.mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast'])]
 valid=[]
 for filename,encoding in sources:
  file=directory/filename
  cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-t','3',*encoding,str(file)]
  result=subprocess.run(cmd,capture_output=True,text=True)
  if result.returncode:
   print(f'SKIP {filename}: unavailable encoder: {result.stderr[-180:]}')
  else:valid.append(file)
 assert valid,'No test codec could be generated'
 server=subprocess.Popen(['python','-m','http.server','8768','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 time.sleep(.7)
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(headless=True)
   ctx=browser.new_context()
   page=ctx.new_page()
   page.goto('http://127.0.0.1:8768/',wait_until='domcontentloaded')
   page.locator('.tool-card').first.wait_for(timeout=15000)
   for file in valid:
    click_sidebar_tool(page,'Информация о видео')
    page.locator('#tool-content input[type=file]').set_input_files(str(file))
    page.locator('#tool-content button.primary').click()
    page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово') || document.querySelector('#tool-status').classList.contains('error')",timeout=30000)
    status=page.locator('#tool-status').inner_text()
    assert 'Готово' in status,f'{file.suffix} could not be decoded: {status}'
    assert '320 × 180' in page.locator('#result-area').inner_text()
    page.locator('#close-workspace').click()
    print(f'PASS decoder: {file.name}, {file.stat().st_size} bytes')
   ctx.close();browser.close()
 finally:
  server.terminate();server.wait(timeout=5)
