"""Grouped sidebar, favorite actions and responsive tool navigation."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess,time

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8787/'
server=subprocess.Popen(['python','-m','http.server','8787','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.6)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None,args=['--no-sandbox'])
  for width in (320,390,768,1024,1440):
   page=browser.new_page(viewport={'width':width,'height':850})
   page.goto(URL,wait_until='domcontentloaded')
   assert page.locator('.sidebar-tool-row').count()==24,width
   assert page.locator('.sidebar-group').count()>=5,width
   assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),width
   mobile=width<=900
   if mobile:
    assert not page.locator('#tool-sidebar').is_visible(),width
    page.locator('#sidebar-toggle').click()
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
    assert page.locator('#sidebar-toggle').get_attribute('aria-expanded')=='true'
    assert page.locator('.sidebar-favorite').first.is_visible()
   else:
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
    assert not page.locator('#sidebar-toggle').is_visible(),width
   # Search only matching group items, keeping category grouping.
   search=page.locator('#search')
   search.fill('субтитры')
   assert 1<=page.locator('.tool-card').count()<24,width
   search.fill('')
   assert page.locator('.tool-card').count()==24,width
   # Star is a sibling button, not nested in the tool opener.
   star=page.locator('[data-favorite-id="video-trim"]')
   if not mobile:page.locator('[data-tool-id="video-trim"].tool-card').hover()
   assert star.is_visible(),width
   star.click()
   assert star.get_attribute('aria-pressed')=='true',width
   assert page.locator('.tool-card').count()==24,width
   page.locator('#categories .chip').filter(has_text='Избранное').click()
   assert page.locator('.tool-card').count()==1,width
   page.reload(wait_until='domcontentloaded')
   if mobile:page.locator('#sidebar-toggle').click()
   page.locator('#categories .chip').filter(has_text='Избранное').click()
   assert page.locator('.tool-card').count()==1,'Favorite did not persist'
   page.locator('#categories .chip').filter(has_text='Все').click()
   # Group can be collapsed and restored by keyboard/mouse.
   group=page.locator('[data-group="Видео"]')
   assert group.get_attribute('open') is not None,width
   group.locator('summary').click()
   assert group.get_attribute('open') is None,width
   group.locator('summary').click()
   assert group.get_attribute('open') is not None,width
   page.locator('.tool-card[data-tool-id="video-trim"]').click()
   assert page.locator('#workspace').is_visible()
   assert page.locator('.tool-card[data-tool-id="video-trim"]').get_attribute('aria-current')=='true'
   if mobile:
    page.locator('#tool-sidebar').wait_for(state='hidden',timeout=4000)
    page.locator('#sidebar-toggle').click()
    page.keyboard.press('Escape')
    page.locator('#tool-sidebar').wait_for(state='hidden',timeout=4000)
   assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),width
   page.close()
   print('PASS sidebar',width)
  browser.close()
finally:
 server.terminate();server.wait(timeout=5)
