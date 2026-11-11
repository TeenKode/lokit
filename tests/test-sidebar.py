"""Grouped sidebar, favorite actions and responsive tool navigation."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
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
    assert page.locator('#tool-sidebar').get_attribute('role')=='dialog'
    assert page.locator('#tool-sidebar').get_attribute('aria-modal')=='true'
    assert page.locator('.header').evaluate('(el)=>el.inert')
    assert page.locator('.footer').evaluate('(el)=>el.inert')
    assert page.locator('.app-content').evaluate('(el)=>el.inert')
    assert page.locator('.sidebar-favorite').first.is_visible()
   else:
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
    assert page.locator('#sidebar-toggle').is_visible(),width
    page.locator('#sidebar-close').click()
    assert not page.locator('#tool-sidebar').is_visible(),width
    assert page.locator('#sidebar-toggle').get_attribute('aria-expanded')=='false'
    page.locator('#sidebar-toggle').click()
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
    assert page.locator('#sidebar-toggle').get_attribute('aria-expanded')=='true'
    assert page.locator('#tool-sidebar').get_attribute('role') is None
   # Ctrl+K must focus the search regardless of previous focus.
   page.keyboard.press('Control+k')
   assert page.locator('#search').evaluate('(input)=>document.activeElement===input'),width
   # Search only matching group items, keeping category grouping.
   search=page.locator('#search')
   search.fill('субтитры')
   assert 1<=page.locator('.tool-card').count()<24,width
   search.fill('')
   assert page.locator('.tool-card').count()==24,width
   # Category controls are recreated after filtering; keyboard focus must persist.
   favorite_chip=page.locator('#categories .chip').filter(has_text='Избранное')
   favorite_chip.focus()
   page.keyboard.press('Enter')
   assert favorite_chip.get_attribute('aria-pressed')=='true',width
   assert favorite_chip.evaluate('(el)=>document.activeElement===el'),width
   page.locator('#categories .chip').filter(has_text='Все').click()
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
   if mobile:assert page.locator('#tool-title').evaluate('(el)=>document.activeElement===el')
   page.locator('.studio-form input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.webm'))
   assert page.locator('#sidebar-recent').is_visible() if not mobile else True
   assert page.locator('#sidebar-recent-name').text_content()=='Обрезка видео'
   assert page.locator('.tool-card[data-tool-id="video-trim"]').get_attribute('aria-current')=='true'
   if mobile:
    page.locator('#tool-sidebar').wait_for(state='hidden',timeout=4000)
    page.locator('#sidebar-toggle').click()
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
    page.locator('#sidebar-recent').wait_for(state='visible',timeout=4000)
    # Tab from the final link wraps to the drawer's first control.
    page.locator('.sidebar-footer-links a').last.focus()
    page.keyboard.press('Tab')
    assert page.locator('#sidebar-close').evaluate('(el)=>document.activeElement===el')
    page.keyboard.press('Escape')
    page.locator('#tool-sidebar').wait_for(state='hidden',timeout=4000)
    assert page.locator('#sidebar-toggle').get_attribute('aria-expanded')=='false'
    assert page.locator('#tool-sidebar').get_attribute('aria-modal') is None
    assert not page.locator('.header').evaluate('(el)=>el.inert')
    assert not page.locator('.footer').evaluate('(el)=>el.inert')
    page.locator('#sidebar-toggle').click()
    page.locator('#tool-sidebar').wait_for(state='visible',timeout=4000)
   else:
    # Desktop catalog stays open while tools run.
    assert page.locator('#tool-sidebar').is_visible()
   assert page.locator('#sidebar-recent-button').get_attribute('aria-label').startswith('Открыть инструмент:')
   page.locator('#sidebar-recent-button').click()
   assert page.locator('.studio-form input[type=file]').evaluate("(el)=>el.files.length===1&&el.files[0].name==='sample.webm'"),width
   assert page.locator('#workspace').is_visible()
   if width==1024:
    # Switching to mobile must not leave focus inside an invisible drawer.
    page.locator('#search').focus()
    page.set_viewport_size({'width':800,'height':850})
    expect(page.locator('#sidebar-toggle')).to_be_focused(timeout=5000)
    page.locator('#tool-sidebar').wait_for(state='hidden',timeout=4000)
    page.locator('#sidebar-toggle').click()
    assert page.locator('#tool-sidebar').get_attribute('aria-modal')=='true'
    page.set_viewport_size({'width':1024,'height':850})
    expect(page.locator('.header')).not_to_have_attribute('inert','',timeout=5000)
    expect(page.locator('#tool-sidebar')).not_to_have_attribute('aria-modal','true',timeout=5000)
    assert page.locator('#sidebar-toggle').get_attribute('aria-expanded')=='true'
   assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),width
   page.close()
   print('PASS sidebar',width)
  browser.close()
finally:
 server.terminate();server.wait(timeout=5)
