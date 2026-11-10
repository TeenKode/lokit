from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess, time, json, shutil, os

ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT / '.test-output'
ARTIFACTS.mkdir(exist_ok=True)
URL='http://127.0.0.1:8766'
server=subprocess.Popen(['python','-m','http.server','8766','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.5)
errors=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  context=browser.new_context(accept_downloads=True,viewport={'width':1280,'height':900})
  page=context.new_page()
  page.on('pageerror',lambda e: errors.append(str(e)))
  page.goto(URL,wait_until='networkidle')
  assert page.locator('.tool-card').count()==24, f"Card count {page.locator('.tool-card').count()}"
  assert page.locator('a[href="./analytics.html"]').count()>=1
  page.screenshot(path=str(ARTIFACTS/'lokit-home-reviewed.png'),full_page=True)
  page.locator('.tool-card').filter(has=page.locator('strong',has_text='SRT ⇄ VTT')).first.click()
  page.locator('#tool-content input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.srt'))
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово')",timeout=20000)
  assert page.locator('.progress-panel').get_attribute('data-stage')=='complete'
  page.goto(URL+'/analytics.html',wait_until='networkidle')
  assert page.locator('#metric-success').inner_text()=='1',page.locator('#metric-success').inner_text()
  assert int(page.locator('#metric-opens').inner_text())>=1
  assert page.locator('#analytics-tools tr').count()>=1
  assert page.locator('#analytics-history').inner_text().count('SRT ⇄ VTT')>=1
  page.screenshot(path=str(ARTIFACTS/'lokit-analytics-local.png'),full_page=True)
  page.locator('#scope-global').click()
  assert 'не подключена' in page.locator('#analytics-message').inner_text().lower()
  page.locator('#scope-local').click()
  page.locator('#analytics-range').select_option('7')
  assert page.locator('#metric-success').inner_text()=='1'
  with page.expect_download() as d:
   page.locator('#analytics-export').click()
  assert d.value.suggested_filename=='lokit-analytics.json'
  page.once('dialog',lambda dialog:dialog.accept())
  page.locator('#analytics-clear').click()
  assert page.locator('#metric-success').inner_text()=='0',page.locator('#metric-success').inner_text()
  page.locator('#share-statistics').uncheck()
  assert page.locator('#share-statistics').is_checked() is False
  page.reload(wait_until='networkidle')
  assert page.locator('#share-statistics').is_checked() is False
  context.set_offline(True)
  page.goto(URL+'/analytics.html',wait_until='domcontentloaded')
  assert page.locator('#scope-local').count()==1
  assert page.locator('#metric-success').inner_text()=='0'
  context.set_offline(False)
  mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
  mobile_page=mobile.new_page()
  mobile_page.on('pageerror',lambda e: errors.append(str(e)))
  mobile_page.goto(URL+'/analytics.html',wait_until='networkidle')
  assert mobile_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (mobile_page.evaluate('document.documentElement.scrollWidth'),mobile_page.evaluate('window.innerWidth'))
  mobile_page.screenshot(path=str(ARTIFACTS/'lokit-analytics-mobile.png'),full_page=True)
  mobile.close()
  print('PASS: 24 tools, navigation, SRT operation, local statistics, global disconnected state, 7d filter, export, delete, sharing toggle, offline, 390px layout')
  print('BROWSER ERRORS:',errors)
  assert not errors,errors
  context.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
