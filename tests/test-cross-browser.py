"""Portable browser smoke: Firefox/WebKit/Chromium. Does not simulate real Android hardware."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from sidebar_nav import click_sidebar_tool
import subprocess, argparse, time, re

root=Path(__file__).resolve().parents[1]
APP_VERSION=re.search(r"APP_VERSION\s*=\s*['\"](\d+\.\d+\.\d+)['\"]",(root/'js/version.js').read_text()).group(1)
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
  # Shared glow layer must be applied after compact/sidebar styles, without animation.
  assert page.locator('link[href="./glow.css"]').count()==1
  # Compare the computed glow COLOR, not just boxShadow != none: old CSS already had shadows.
  def assert_soft_glow(selector):
   shadow=page.locator(selector).first.evaluate('(element) => getComputedStyle(element).boxShadow')
   assert '128, 195, 255' in shadow,(selector,'Expected blue halo, got:',shadow)
  assert_soft_glow('.hero-copy')
  assert_soft_glow('.hero-panel')
  assert_soft_glow('.tool-sidebar')
  assert_soft_glow('.header .ghost-button')
  radius=page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--glow-radius').trim()")
  assert radius==('8px' if args.mobile else '13px'),('Unexpected glow blur radius',radius)
  assert page.evaluate("getComputedStyle(document.querySelector('.page-glow')).animationName == 'none'"),'Background unexpectedly animates'
  picker=page.locator('#background-choice')
  picker.wait_for(state='attached',timeout=15000)
  assert picker.locator('option').count()==11,'Background selector options'
  for theme in ['aurora','topography','constellations','flow','lenses','geometry','dust','interference','polygons','none']:
   picker.select_option(theme)
   assert page.locator('.page-glow').get_attribute('data-background-theme')==theme,theme
   if theme not in ('none','aurora'):
    assert page.evaluate("getComputedStyle(document.querySelector('.page-glow'),'::before').backgroundImage.includes('data:image/svg+xml')"),theme
  picker.select_option('topography')
  page.reload(wait_until='domcontentloaded')
  picker=page.locator('#background-choice')
  assert picker.input_value()=='topography','Background preference did not persist'
  assert page.locator('.page-glow').get_attribute('data-background-theme')=='topography'
  assert page.evaluate("getComputedStyle(document.querySelector('.page-glow')).animationName=='none'")
  if args.mobile:page.locator('#sidebar-toggle').click()
  page.locator('.tool-card').first.wait_for(timeout=20000)
  assert page.locator('.tool-card').count()==24
  assert 'v'+APP_VERSION in page.locator('.version-pill').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'Horizontal overflow'
  click_sidebar_tool(page,'Обрезка видео')
  assert page.locator('.studio-shell').count()==1
  assert_soft_glow('.studio-shell')
  assert_soft_glow('.studio-settings')
  assert page.locator('.studio-reset-settings').count()==1
  page.locator('[name=start]').fill('2.25')
  page.locator('[name=start]').blur()
  page.reload(wait_until='domcontentloaded')
  if args.mobile:page.locator('#sidebar-toggle').click()
  click_sidebar_tool(page,'Обрезка видео')
  assert page.locator('[name=start]').input_value()=='2.25','Settings not restored'
  page.locator('.studio-reset-settings').click()
  assert page.locator('[name=start]').input_value()=='0'
  page.locator('#close-workspace').click()
  if args.mobile:page.locator('#sidebar-toggle').click()
  click_sidebar_tool(page,'SRT ⇄ VTT')
  page.locator('#tool-content input[type=file]').set_input_files(str(root/'tests/fixtures/sample.srt'))
  page.locator('.studio-cue-list .studio-cue textarea').first.wait_for(timeout=15000)
  page.locator('.studio-cue-list .studio-cue textarea').first.fill(f'Lokit {args.browser} mobile={args.mobile}')
  page.locator('#tool-content button.primary').click()
  page.wait_for_function("() => document.querySelector('#tool-status').textContent.includes('Готово')",timeout=20000)
  with page.expect_download() as download:page.locator('.download a').first.click()
  assert f'Lokit {args.browser}' in Path(download.value.path()).read_text(encoding='utf-8')
  page.goto(url+'batch.html',wait_until='domcontentloaded')
  assert_soft_glow('.batch-panel')
  assert page.locator('#background-choice').input_value()=='topography'
  assert page.locator('.page-glow').get_attribute('data-background-theme')=='topography'
  page.goto(url+'analytics.html',wait_until='domcontentloaded')
  assert_soft_glow('.metric-card')
  assert page.locator('#background-choice').input_value()=='topography'
  assert page.locator('#metric-success').inner_text()=='1'
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
  page.goto(url+'about.html',wait_until='domcontentloaded')
  assert_soft_glow('.analytics-panel')
  assert page.locator('#background-choice').input_value()=='topography'
  assert 'v'+APP_VERSION in page.locator('#release-title').inner_text()
  assert not errors,errors
  print(f'PASS: {args.browser}, mobile emulation={args.mobile}, presets, SRT editing/export, local analytics, layout')
  ctx.close();browser.close()
finally:
 server.terminate();server.wait(timeout=5)
