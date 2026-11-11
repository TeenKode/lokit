"""Chromium: missing local optional engines must not break the ordinary export."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess,time
root=Path(__file__).resolve().parents[1]
server=subprocess.Popen(['python','-m','http.server','8778','--bind','127.0.0.1','--directory',str(root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  context=browser.new_context(accept_downloads=True)
  page=context.new_page()
  errors=[];remote=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/assets/codecs/**',lambda route:(remote.append(route.request.url),route.abort()))
  page.goto('http://127.0.0.1:8778/',wait_until='domcontentloaded')
  page.locator('.tool-card').filter(has_text='Конвертер видео').first.click()
  chooser=page.locator('select[name=engine]')
  assert chooser.count()==1,'Engine select should exist in the converter'
  assert chooser.input_value()=='classic','Ordinary path must be the default'
  assert not remote,'Libraries should not load on page open'
  page.locator('#tool-content input[type=file]').set_input_files(str(root/'tests/fixtures/sample.webm'))
  chooser.select_option('webcodecs')
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => /Готово|Ошибка|отменена/i.test(document.querySelector('#tool-status').textContent)",timeout=90000)
  status=page.locator('#tool-status').inner_text()
  assert 'Готово' in status,f'No fallback: {status}'
  assert page.locator('.download a').count()>0
  assert not errors,errors
  print('PASS: opt-in selection, blocked optional local codec, automatic traditional encoder fallback')
  context.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
