"""Browser recovery: broken input must not poison the next job."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from sidebar_nav import click_sidebar_tool
import subprocess,time
ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8788/'
server=subprocess.Popen(['python','-m','http.server','8788','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None,args=['--no-sandbox'])
  context=browser.new_context(accept_downloads=True)
  page=context.new_page()
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(URL,wait_until='domcontentloaded')
  click_sidebar_tool(page,'Информация о видео')
  chooser=page.locator('.studio-form input[type=file]')
  chooser.set_input_files({'name':'broken.mp4','mimeType':'video/mp4','buffer':bytes([255])*512})
  page.locator('.studio-form button.primary').click()
  page.wait_for_function("() => document.querySelector('.progress-panel')?.dataset.stage === 'error'",timeout=23000)
  assert not page.locator('.download a').count()
  assert page.locator('.studio-form').get_attribute('aria-busy')=='false'
  chooser.set_input_files(str(ROOT/'tests/fixtures/sample.webm'))
  page.locator('.studio-form button.primary').click()
  page.wait_for_function("() => document.querySelector('.progress-panel')?.dataset.stage === 'complete'",timeout=20000)
  assert page.locator('#tool-status').inner_text().startswith('Готово')
  assert not errors,errors
  context.close();browser.close()
 print('Reliability browser: damaged input rejected, next valid video accepted — PASS')
finally:
 server.terminate();server.wait(timeout=5)
