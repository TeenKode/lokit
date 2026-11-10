from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess, time, json, shutil, os, re

ROOT=Path(__file__).resolve().parents[1]
APP_VERSION=re.search(r"APP_VERSION\s*=\s*['\"](\d+\.\d+\.\d+)['\"]",(ROOT/'js/version.js').read_text()).group(1)
ARTIFACTS=ROOT / '.test-output'
ARTIFACTS.mkdir(exist_ok=True)
URL='http://127.0.0.1:8766'
server=subprocess.Popen(['python','-m','http.server','8766','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.5)
errors=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=('/usr/bin/chromium' if os.path.exists('/usr/bin/chromium') else None),args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  context=browser.new_context(accept_downloads=True,viewport={'width':1280,'height':900})
  page=context.new_page()
  page.on('pageerror',lambda e: errors.append(str(e)))
  page.goto(URL,wait_until='networkidle')
  assert page.locator('.tool-card').count()==24, f"Card count {page.locator('.tool-card').count()}"
  assert 'v'+APP_VERSION in page.locator('.version-pill').inner_text()
  page.locator('.version-pill').click()
  assert page.url.endswith('/about.html')
  assert 'Версия' in page.locator('#release-title').inner_text()
  assert 'v'+APP_VERSION in page.locator('#release-title').inner_text()
  page.goto(URL,wait_until='networkidle')
  assert page.locator('a[href="./analytics.html"]').count()>=1
  page.screenshot(path=str(ARTIFACTS/'lokit-home-reviewed.png'),full_page=True)
  page.locator('.tool-card').filter(has=page.locator('strong',has_text='SRT ⇄ VTT')).first.click()
  page.locator('#tool-content input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.srt'))
  assert page.locator('.studio-shell').count()==1
  page.locator('#favorite-tool').click()
  assert page.locator('#favorite-tool').get_attribute('aria-pressed')=='true'
  page.locator('.studio-cue-list .studio-cue textarea').first.fill('Изменено в редакторе Lokit')
  assert page.locator('.studio-sub-preview').count()==1
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово')",timeout=20000)
  assert page.locator('.progress-panel').get_attribute('data-stage')=='complete'
  with page.expect_download() as edited:
   page.locator('.download a').first.click()
  assert 'Изменено в редакторе Lokit' in Path(edited.value.path()).read_text(encoding='utf-8')
  page.locator('.studio-cue-list .studio-cue textarea').first.fill('Новый текст после экспорта')
  assert page.locator('.download a').count()==0,'Stale result must be removed after editing'
  page.locator('#close-workspace').click()
  page.locator('#categories .chip').filter(has_text='Избранное').click()
  assert page.locator('.tool-card').count()==1,'Favorite filter must show saved tool'
  page.reload(wait_until='networkidle')
  page.locator('#categories .chip').filter(has_text='Избранное').click()
  assert page.locator('.tool-card').count()==1,'Favorite must persist after reload'
  page.locator('#categories .chip').filter(has_text='Все').click()
  page.locator('.tool-card').filter(has=page.locator('strong',has_text='Обрезка видео')).first.click()
  page.locator('#tool-content input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.webm'))
  page.locator('.studio-video-panel:not(.hidden) .studio-rendered-canvas').first.wait_for(state='visible',timeout=15000)
  page.wait_for_function("() => document.querySelector('.studio-rendered-canvas').width > 0",timeout=15000)
  page.locator('.studio-source-timeline .tt-strip').wait_for(state='visible',timeout=12000)
  assert page.locator('.studio-player').count()>=1
  assert page.locator('.studio-video-surface').evaluate('(el)=>el.classList.contains(\"studio-show-render\")')
  assert page.locator('.studio-trim-controls input[type=range]').count()==2
  page.locator('[name=start]').fill('1.25')
  page.locator('[name=end]').fill('0.50')
  page.locator('#tool-content button.primary').click()
  assert 'позже начала' in page.locator('#tool-status').inner_text()
  assert page.locator('.download a').count()==0
  # A controlled slow operation checks that inputs and the visual timeline stay locked.
  page.locator('[name=end]').fill('0')
  page.evaluate("""async () => {
    const {tools}=await import('./js/tools.js');
    const t=tools.find(item=>item.id==='video-trim');
    t.run=({signal})=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>resolve({blob:new Blob(['test'],{type:'video/webm'}),name:'test.webm'}),650);
      signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));},{once:true});
    });
  }""")
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('.studio-form').getAttribute('aria-busy')==='true'")
  assert page.locator('#tool-content input[type=file]').is_disabled()
  assert page.locator('.studio-main').evaluate('(node)=>node.inert') is True
  page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово')",timeout=10000)
  assert not page.locator('#tool-content input[type=file]').is_disabled()
  assert page.locator('.download a').count()==1
  page.locator('[name=start]').fill('0.5')
  assert page.locator('.download a').count()==0, 'Old video result must be removed when settings change'
  page.locator('#close-workspace').click()
  page.goto(URL,wait_until='networkidle')
  page.locator('.tool-card').filter(has=page.locator('strong',has_text='Удалить звук')).first.click()
  assert page.locator('select[name=resolution]').count()==1
  assert 'Как у исходного' in page.locator('select[name=resolution]').inner_text()
  assert '1280×720' in page.locator('.field small').filter(has_text='1920×1080').inner_text()
  page.locator('#tool-content input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample-audio.mp4'))
  page.wait_for_function("() => document.querySelector('.studio-resolution')?.textContent.includes('160')",timeout=15000)
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('#tool-status')?.textContent.includes('Готово')",timeout=15000)
  assert 'без перекодирования' in page.locator('.download').inner_text()
  with page.expect_download() as mp4:
   page.locator('.download a').first.click()
  assert mp4.value.suggested_filename.endswith('.mp4')
  page.locator('#close-workspace').click()
  page.goto(URL+'/analytics.html',wait_until='networkidle')
  assert page.locator('#metric-success').inner_text()=='3',page.locator('#metric-success').inner_text()
  assert 'v'+APP_VERSION in page.locator('.version-pill').inner_text()
  assert int(page.locator('#metric-opens').inner_text())>=1
  assert page.locator('#analytics-tools tr').count()>=1
  assert page.locator('#analytics-history').inner_text().count('SRT ⇄ VTT')>=1
  page.screenshot(path=str(ARTIFACTS/'lokit-analytics-local.png'),full_page=True)
  page.locator('#analytics-range').select_option('7')
  assert page.locator('#metric-success').inner_text()=='3'
  with page.expect_download() as d:
   page.locator('#analytics-export').click()
  assert d.value.suggested_filename=='lokit-analytics.json'
  page.once('dialog',lambda dialog:dialog.accept())
  page.locator('#analytics-clear').click()
  assert page.locator('#metric-success').inner_text()=='0',page.locator('#metric-success').inner_text()
  context.set_offline(True)
  page.goto(URL+'/analytics.html',wait_until='domcontentloaded')
  assert page.locator('#scope-global').count()==0
  assert page.locator('#metric-success').inner_text()=='0'
  page.goto(URL+'/about.html',wait_until='domcontentloaded')
  assert 'v'+APP_VERSION in page.locator('#release-title').inner_text()
  context.set_offline(False)
  mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
  mobile_page=mobile.new_page()
  mobile_page.on('pageerror',lambda e: errors.append(str(e)))
  mobile_page.goto(URL+'/analytics.html',wait_until='networkidle')
  assert mobile_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (mobile_page.evaluate('document.documentElement.scrollWidth'),mobile_page.evaluate('window.innerWidth'))
  mobile_page.screenshot(path=str(ARTIFACTS/'lokit-analytics-mobile.png'),full_page=True)
  for url in [URL,URL+'/about.html']:
   mobile_page.goto(url,wait_until='networkidle')
   assert mobile_page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),url
  mobile.close()
  print('PASS: 24 tools, version badge, about offline, favorites, input validation, busy lock, stale-result cleanup, SRT, personal analytics, mobile layout')
  print('BROWSER ERRORS:',errors)
  assert not errors,errors
  context.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
