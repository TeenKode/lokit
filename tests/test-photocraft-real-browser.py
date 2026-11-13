"""Run the actual SHA-pinned PhotoCraft web release through Chromium.

Unlike the small offline fixture this exercises upstream HTML, chunked
WebAssembly boot and Lokit's iframe + Service Worker together.
The CI artcraft job stages the official ZIP before running this test.
"""
from contextlib import closing
import http.server
from pathlib import Path
import socket
import socketserver
import threading
import time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/"craft-apps"/"photocraft"
assert (APP/"index.html").is_file(), "Official PhotoCraft browser release must be staged"
assert (APP/"lokit-assets.json").is_file()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*args,**kw):
        super().__init__(*args,directory=str(ROOT),**kw)
    def log_message(self,*args):
        pass
    def guess_type(self,path):
        if path.endswith(".wasm"):return "application/wasm"
        if path.endswith(".js"):return "text/javascript"
        return super().guess_type(path)

class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):
    daemon_threads=True
    allow_reuse_address=True

with closing(Server(("127.0.0.1",0),Handler)) as server:
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        url=f"http://127.0.0.1:{server.server_port}/craft.html?app=photocraft"
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(
                headless=True,
                args=["--enable-webgl","--use-gl=angle","--use-angle=swiftshader",
                      "--enable-unsafe-swiftshader","--disable-gpu-sandbox"]
            )
            context=browser.new_context(viewport={"width":1280,"height":800})
            page=context.new_page()
            errors=[]
            failures=[]
            page.on("pageerror",lambda error:errors.append(str(error)))
            page.on("requestfailed",lambda request:failures.append(request.url+" "+str(request.failure)))
            started=time.monotonic()
            page.goto(url,wait_until="domcontentloaded",timeout=30000)
            page.locator("#craft-frame").wait_for(state="visible",timeout=120000)
            iframe=page.frame_locator("#craft-frame")
            iframe.locator("#photocraft_canvas").wait_for(state="attached",timeout=25000)
            print("PhotoCraft actual release: iframe mounted after %.1f s" % (time.monotonic()-started),flush=True)
            try:
                iframe.locator("#photocraft_loading").wait_for(state="detached",timeout=90000)
            except Exception:
                loader=iframe.locator("#photocraft_loading")
                current=loader.inner_text(timeout=3000) if loader.count() else "(removed)"
                outer=page.locator("#craft-progress-detail").inner_text(timeout=3000)
                print("PhotoCraft startup FAIL. vendor loader:",current,flush=True)
                print("Lokit loader:",outer,flush=True)
                print("Errors:",errors[-15:],flush=True)
                print("Network failures:",failures[-15:],flush=True)
                raise
            canvas=iframe.locator("#photocraft_canvas")
            size=canvas.bounding_box()
            print("PhotoCraft actual release loaded in %.1f s; canvas=%s" % (time.monotonic()-started,size),flush=True)
            assert size is not None and size["width"]>300 and size["height"]>250, size
            assert not failures, failures
            context.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=10)
