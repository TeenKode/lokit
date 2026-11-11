"""Chromium integration: prefetched same-origin engines work offline and can be removed."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess, time, sys
ROOT=Path(__file__).resolve().parents[1]
server=subprocess.Popen([sys.executable,'-m','http.server','8797','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.7)
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True)
  context=browser.new_context()
  page=context.new_page()
  errors=[]
  page.on('pageerror',lambda err:errors.append(str(err)))
  page.goto('http://127.0.0.1:8797/about.html',wait_until='domcontentloaded')
  page.wait_for_function("() => navigator.serviceWorker.controller !== null",timeout=30000)
  page.locator('#offline-codecs-download').click()
  page.wait_for_function("() => document.querySelector('#offline-codecs-status')?.textContent.includes('Все три модуля')",timeout=120000)
  assert page.locator('#offline-codecs-download').is_disabled()
  context.set_offline(True)
  page.reload(wait_until='domcontentloaded')
  page.wait_for_function("() => document.querySelector('#offline-codecs-status')?.textContent.includes('Все три модуля')",timeout=15000)
  results=page.evaluate("""async () => {
    const {DEPENDENCIES}=await import('./js/codec-assets.js');
    return Promise.all(Object.values(DEPENDENCIES).map(async url=>{
      const resp=await fetch(url);
      return {status:resp.status,bytes:(await resp.blob()).size};
    }));
  }""")
  assert len(results)==3 and all(item['status']==200 and item['bytes']>100000 for item in results),results
  page.locator('#offline-codecs-remove').click()
  page.wait_for_function("() => document.querySelector('#offline-codecs-status')?.textContent.includes('Сохранено 0 из 3')",timeout=15000)
  assert page.locator('#offline-codecs-download').is_enabled()
  status=page.evaluate("async()=> (await fetch('./assets/codecs/ffmpeg-core-0.12.10.wasm')).status")
  assert status==503,('Uncached codec must not fetch offline',status)
  assert not errors,errors
  context.close()
  browser.close()
  print('PASS: real local codec prefetch, offline reload, three offline loads and purge')
finally:
 server.terminate()
 server.wait(timeout=5)
