"""Portable browser smoke: Firefox/WebKit/Chromium. Does not simulate real Android hardware."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess, argparse, time

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--browser',choices=['chromium','firefox','webkit'],default='chromium')
parser.add_argument('--mobile',action='store_true')
args=parser.parse_args()
errors=[]
server=subprocess.Popen(['python','-m','http.server','8767','--bind','127.0.0.1','--directory',str(root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.8)
url='http://127.0.0.1:8767/'
try:
 with sync_playwright() as p:
  browser=getattr(p,args.browser).launch(headless=True)
  settings={'viewport':{'width':390,'height':844} if args.mobile else {'width':1280,'height':850},'accept_downloads':True}
  if args.mobile and args.browser=='chromium':settings.update({'is_mobile':True,'has_touch':True})
  ctx=browser.new_context(**settings)
  page=ctx.new_page()
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(url,wait_until='domcontentloaded')
  page.locator('.tool-card').first.wait_for(timeout=20000)
  assert page.locator('.tool-card').count()==24
  assert 'v0.4.0' in page.locator('.version-pill').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'Horizontal overflow'
  page.locator('.tool-card').filter(has_text='Обрезка видео').first.click()
  assert page.locator('.studio-shell').count()==1
  assert page.locator('.studio-reset-settings').count()==1
  page.locator('[name=start]').fill('2.25')
  page.locator('[name=start]').blur()
  page.reload(wait_until='domcontentloaded')
  page.locator('.tool-card').filter(has_text='Обрезка видео').first.click()
  assert page.locator('[name=start]').input_value()=='2.25','Settings not restored'
  page.locator('.studio-reset-settings').click()
  assert page.locator('[name=start]').input_value()=='0'
  page.locator('#close-workspace').click()
  page.locator('.tool-card').filter(has_text='SRT ⇄ VTT').first.click()
  page.locator('#tool-content input[type=file]').set_input_files(str(root/'tests/fixtures/sample.srt'))
  page.locator('.studio-cue-list .studio-cue textarea').first.wait_for(timeout=15000)
  page.locator('.studio-cue-list .studio-cue textarea').first.fill(f'Lokit {args.browser} mobile={args.mobile}')
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово')",timeout=20000)
  with page.expect_download() as download:page.locator('.download a').first.click()
  assert f'Lokit {args.browser}' in Path(download.value.path()).read_text(encoding='utf-8')
  page.goto(url+'analytics.html',wait_until='domcontentloaded')
  assert page.locator('#metric-success').inner_text()=='1'
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
  page.goto(url+'about.html',wait_until='domcontentloaded')
  assert 'v0.4.0' in page.locator('#release-title').inner_text()
  assert not errors,errors
  print(f'PASS: {args.browser}, mobile emulation={args.mobile}, presets, SRT editing/export, local analytics, layout')
  ctx.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
