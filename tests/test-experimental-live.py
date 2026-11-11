"""Diagnostic: use packaged same-origin optional engines and encode short local files in Chromium.
Does not upload media. Runs against assets installed during CI; no external runtime requests.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from sidebar_nav import click_sidebar_tool
import subprocess,time,sys
root=Path(__file__).resolve().parents[1]
server=subprocess.Popen([sys.executable,'-m','http.server','8779','--bind','127.0.0.1','--directory',str(root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as playwright:
  browser=playwright.chromium.launch(headless=True)
  context=browser.new_context(accept_downloads=True)
  page=context.new_page()
  logs=[];errors=[]
  page.on('console',lambda x:logs.append(x.text))
  page.on('pageerror',lambda x:errors.append(str(x)))
  page.goto('http://127.0.0.1:8779/',wait_until='domcontentloaded')
  click_sidebar_tool(page,'Конвертер видео')
  file=str(root/'tests/fixtures/sample-silent.mp4')
  for engine,expected in [('webcodecs','WebCodecs'),('ffmpeg','FFmpeg/WASM')]:
   page.locator('#tool-content input[type=file]').set_input_files(file)
   page.locator('select[name=engine]').select_option(engine)
   page.locator('#tool-content button.primary').click()
   try:
    page.wait_for_function('''() => {
      const status=document.querySelector('#tool-status')?.textContent||'';
      return status.includes('Готово') || status.includes('Ошибка') || status.includes('отменена');
    }''',timeout=230000)
   except Exception:
    print('EXPERIMENTAL TIMEOUT',engine,'logs:',logs[-8:], 'errors:',errors)
    raise
   status=page.locator('#tool-status').inner_text()
   details=page.locator('.download small').first.inner_text() if page.locator('.download small').count() else ''
   print('EXPERIMENTAL',engine,'status=',status,'details=',details,'logs=',logs[-5:])
   assert 'Готово' in status,(engine,status,logs[-8:])
   assert expected in details,(engine,'fallback used instead of real experimental engine',details,logs[-8:])
  assert not errors,errors
  context.close();browser.close()
  print('PASS: actual WebCodecs and FFmpeg/WASM MP4 export in Chromium')
finally:
 server.terminate();server.wait(timeout=5)
