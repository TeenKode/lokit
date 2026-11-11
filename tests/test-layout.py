"""Responsive layout regression at real browser widths (GitHub Actions Chromium)."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess, time

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8783'
OUTPUT=ROOT/'.test-output'
OUTPUT.mkdir(exist_ok=True)
server=subprocess.Popen(['python','-m','http.server','8783','--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.5)

def document_fits(page, name):
    numbers=page.evaluate('''() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})''')
    assert numbers['document']<=numbers['viewport']+1,(name,numbers)
    assert numbers['body']<=numbers['viewport']+1,(name,numbers)

def check_columns(page,width):
    data=page.evaluate('''() => {
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
      return {main:rect('.studio-main'),settings:rect('.studio-settings')};
    }''')
    assert data['main']['width']>=200,(width,data)
    assert data['settings']['width']>=200,(width,data)
    if width>1190:
        assert data['main']['right']<=data['settings']['left']+2,(width,data)
    else:
        assert data['main']['bottom']<=data['settings']['top']+2,(width,data)

try:
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None,args=['--no-sandbox'])
        context=browser.new_context()
        page=context.new_page()
        for width in [320,390,768,1024,1440]:
            page.set_viewport_size({'width':width,'height':920})
            page.goto(URL+'/',wait_until='domcontentloaded')
            if width<=900:page.locator('#sidebar-toggle').click()
            page.locator('.tool-card').first.wait_for(state='visible')
            assert page.locator('link[href="./layout-compact.css"]').count()==1
            assert page.locator('link[href="./sidebar.css"]').count()==1
            document_fits(page,f'home {width}')
            header=page.locator('.header').bounding_box()
            assert header['height']<115,(width,header)
            if width<=650:
                nav=page.locator('.header-right')
                assert nav.evaluate('(el)=>getComputedStyle(el).overflowX')=='auto'
                assert page.locator('#tool-sidebar').is_visible()
            page.locator('.tool-card').filter(has=page.locator('strong',has_text='Обрезка видео')).first.click()
            assert page.locator('.studio-main .dropzone').count()==1
            assert page.locator('.studio-settings').count()==1
            check_columns(page,width)
            page.locator('#workspace').evaluate('(el)=>el.scrollIntoView({block:"start",behavior:"instant"})')
            page.wait_for_timeout(70)
            work=page.locator('#workspace').bounding_box()
            header=page.locator('.header').bounding_box()
            assert work['y']+2>=header['y']+header['height'],(width,work,header)
            page.locator('.studio-form input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.webm'))
            page.locator('.precision-editor').wait_for(state='visible',timeout=15000)
            document_fits(page,f'trim {width}')
            page.screenshot(path=str(OUTPUT/f'layout-trim-{width}.png'))
            page.locator('#close-workspace').click()
            if width<=900:page.locator('#sidebar-toggle').click()
            page.locator('.tool-card').filter(has=page.locator('strong',has_text='SRT ⇄ VTT')).first.click()
            page.locator('.studio-form input[type=file]').set_input_files(str(ROOT/'tests/fixtures/sample.srt'))
            page.locator('.subtitle-lane').first.wait_for(state='visible',timeout=8000)
            document_fits(page,f'subtitles {width}')
            page.goto(URL+'/batch.html',wait_until='domcontentloaded')
            page.locator('#batch-tool option').first.wait_for(state='attached')
            document_fits(page,f'batch {width}')
            page.screenshot(path=str(OUTPUT/f'layout-batch-{width}.png'))
            print('PASS layout width',width)
        context.close();browser.close()
finally:
    server.terminate()
    server.wait(timeout=5)
