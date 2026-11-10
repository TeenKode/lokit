"""End-to-end: mixed-tool queue, real SRT outputs, ZIP bytes/CRC, and offline PWA."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import argparse, subprocess, zipfile, time, os

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--browser',choices=['chromium','firefox','webkit'],default='chromium')
parser.add_argument('--mobile',action='store_true')
args=parser.parse_args()
server=subprocess.Popen(['python','-m','http.server','8776','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
errors=[]
try:
 with sync_playwright() as playwright:
  browser=getattr(playwright,args.browser).launch(headless=True,**({'executable_path':os.environ['BROWSER_EXECUTABLE']} if os.environ.get('BROWSER_EXECUTABLE') else {}))
  kwargs={'viewport':{'width':390,'height':844} if args.mobile else {'width':1340,'height':900},'accept_downloads':True}
  if args.mobile and args.browser=='chromium':kwargs.update({'is_mobile':True,'has_touch':True})
  context=browser.new_context(**kwargs)
  page=context.new_page()
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto('http://127.0.0.1:8776/batch.html',wait_until='domcontentloaded')
  page.locator('#batch-tool option').first.wait_for(timeout=20000)
  assert 'v0.6.0' in page.locator('.version-pill').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'Horizontal overflow in batch mode'
  page.locator('#batch-tool').select_option('subtitle-converter')
  first=(ROOT/'tests/fixtures/sample.srt').read_bytes()
  page.locator('#batch-files').set_input_files([
   {'name':'один.srt','mimeType':'text/plain','buffer':first},
   {'name':'два.srt','mimeType':'text/plain','buffer':first},
  ])
  page.locator('#batch-add').click()
  assert page.locator('.batch-job').count()==2,'Expected 2 queued conversions'
  page.locator('#batch-tool').select_option('subtitle-shift')
  page.locator('[name=seconds]').fill('1.5')
  page.locator('#batch-files').set_input_files({'name':'сдвиг.srt','mimeType':'text/plain','buffer':first})
  page.locator('#batch-add').click()
  page.locator('#batch-tool').select_option('subtitle-merger')
  page.locator('#batch-files').set_input_files([
    {'name':'a.srt','mimeType':'text/plain','buffer':first},
    {'name':'b.srt','mimeType':'text/plain','buffer':first},
  ])
  page.locator('#batch-add').click()
  assert page.locator('.batch-job').count()==4,'Expected 4 jobs across 3 different tools'
  assert page.locator('.batch-job').filter(has_text='a.srt + b.srt').count()==1,'Pair grouping failed'
  page.locator('#batch-start').click()
  page.wait_for_function("() => document.querySelectorAll('.batch-job[data-status=success]').length===4",timeout=30000)
  assert page.locator('#batch-overall-percent').inner_text()=='100%'
  assert page.locator('#batch-zip').is_enabled()
  with page.expect_download(timeout=30000) as info:page.locator('#batch-zip').click()
  zip_path=Path(info.value.path())
  with zipfile.ZipFile(zip_path) as archive:
   assert archive.testzip() is None
   names=archive.namelist()
   assert len(names)==4,names
   assert len(set(names))==4
   vtt=[name for name in names if name.endswith('.vtt')]
   assert len(vtt)==2,names
   assert all(archive.read(name).startswith(b'WEBVTT') for name in vtt)
   assert any('00:00:01,500' in archive.read(name).decode('utf-8') for name in names if name.endswith('.srt'))
   assert any('merged-subtitles' in name for name in names)
  with page.expect_download() as dl:
   page.locator('.batch-job[data-status=success] button').filter(has_text='Скачать').first.click()
  assert Path(dl.value.path()).stat().st_size>0
  # Browser queue and files are ephemeral; no IndexedDB/localStorage copies of media.
  assert page.evaluate("Object.keys(localStorage).every(k=>!k.includes('batch'))")
  if args.browser=='chromium':
   page.evaluate("() => navigator.serviceWorker.ready")
   context.set_offline(True)
   page.reload(wait_until='domcontentloaded')
   page.locator('#batch-tool option').first.wait_for(timeout=20000)
   assert page.locator('.batch-job').count()==0
   context.set_offline(False)
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
  assert not errors,errors
  print(f'PASS batch browser: {args.browser}, mobile={args.mobile}, 4 mixed jobs, per-file downloads, real ZIP CRC, offline')
  context.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
