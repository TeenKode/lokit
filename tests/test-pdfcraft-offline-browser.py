"""Chromium PDFCraft offline cache regression using a tiny mock release."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import time
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
bundle=root/'pdfcraft'
assert not bundle.exists(),'Tests must not overwrite a real PDFCraft release'
server=None
try:
    (bundle/'models').mkdir(parents=True)
    (bundle/'index.html').write_text('<!doctype html><canvas id="pdfcraft"></canvas>')
    (bundle/'module.wasm').write_bytes(b'\x00asm'+bytes(range(12)))
    (bundle/'models'/'ocr.onnx').write_bytes(bytes(range(24)))
    names=['index.html','module.wasm','models/ocr.onnx','offline-assets.json']
    (bundle/'offline-assets.json').write_text(json.dumps({
        'version':'0.21.1',
        'files':['./'+name for name in names]
    }))
    server=subprocess.Popen(
        [sys.executable,'-m','http.server','8806','--bind','127.0.0.1',
         '--directory',str(root)],
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL
    )
    time.sleep(.7)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        context=browser.new_context()
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('http://127.0.0.1:8806/pdf.html',wait_until='domcontentloaded')
        page.wait_for_function('() => navigator.serviceWorker.controller !== null',timeout=30000)
        page.locator('#offline-pdf').click()
        page.wait_for_function(
            "() => document.querySelector('#pdf-status').textContent.includes('сохранены для работы без интернета')",
            timeout=25000
        )
        urls=page.evaluate("""async()=>{
          const c=await caches.open('lokit-pdfcraft-v0.21.1-r2');
          return (await c.keys()).map(x=>x.url);
        }""")
        assert len(urls)==4,urls
        assert all('lokit-pdfcraft-prefetch' not in url for url in urls),urls
        context.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        page.locator('#pdf-frame').wait_for(state='visible',timeout=10000)
        assets=page.evaluate("""async()=>{
          const paths=['./pdfcraft/','./pdfcraft/module.wasm','./pdfcraft/models/ocr.onnx'];
          return Promise.all(paths.map(async url=>{
            const r=await fetch(url);
            return [r.status,(await r.arrayBuffer()).byteLength];
          }));
        }""")
        assert all(status==200 and size>0 for status,size in assets),assets
        assert not errors,errors
        context.close()
        browser.close()
    print('PASS PDFCraft offline: prefetch and cold offline reload with WASM and OCR')
finally:
    if server:
        server.terminate()
        server.wait(timeout=5)
    shutil.rmtree(bundle,ignore_errors=True)
