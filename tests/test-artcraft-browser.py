"""End-to-end loader progress and offline cold restart with Chromium."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
base=ROOT/"craft-apps"
fixture=base/"photocraft"
assert not base.exists(),"Tests must not overwrite vendor bundles"
server=None
try:
    fixture.mkdir(parents=True)
    (fixture/"index.html").write_text("<!doctype html><html><head><title>PhotoCraft fixture</title></head><body><h1>Offline ArtCraft fixture</h1></body></html>")
    (fixture/"app_bg.wasm").write_bytes(b"\0asm"+bytes(range(16)))
    entries=[]
    for name in ("index.html","app_bg.wasm"):
        entries.append({"path":"./"+name,"bytes":(fixture/name).stat().st_size})
    (fixture/"lokit-assets.json").write_text(json.dumps({
        "schema":1,"name":"photocraft","version":"0.23.1",
        "assets":entries,"totalBytes":sum(x["bytes"] for x in entries)
    }))
    server=subprocess.Popen(
        [sys.executable,"-m","http.server","8807","--bind","127.0.0.1","--directory",str(ROOT)],
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL
    )
    time.sleep(.7)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        context=browser.new_context()
        page=context.new_page()
        errors=[]
        page.on("pageerror",lambda err:errors.append(str(err)))
        page.goto("http://127.0.0.1:8807/craft.html?app=photocraft",wait_until="domcontentloaded")
        page.wait_for_function(
            "() => document.querySelector('#craft-status')?.textContent.includes('PhotoCraft открыт')",
            timeout=40000
        )
        assert page.locator("#craft-frame").is_visible()
        assert page.locator("#craft-loader").is_hidden()
        assert "Offline ArtCraft fixture" in page.frame_locator("#craft-frame").locator("body").inner_text()
        cached=page.evaluate("""async () => {
          const cache=await caches.open('lokit-craft-v1-photocraft');
          return (await cache.keys()).map(x=>x.url);
        }""")
        assert len(cached)==3,cached
        assert all("lokit-craft-prefetch" not in url for url in cached),cached
        context.set_offline(True)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function(
            "() => document.querySelector('#craft-status')?.textContent.includes('PhotoCraft открыт')",
            timeout=25000
        )
        assert "Offline ArtCraft fixture" in page.frame_locator("#craft-frame").locator("body").inner_text()
        binary=page.evaluate("""async()=>{
          const response=await fetch('./craft-apps/photocraft/app_bg.wasm');
          return [response.status,(await response.arrayBuffer()).byteLength];
        }""")
        assert binary==[200,20],binary
        assert not errors,errors
        context.close()
        browser.close()
    print("PASS ArtCraft: visible loader, real iframe, complete cache and offline reload")
finally:
    if server:
        server.terminate()
        server.wait(timeout=5)
    shutil.rmtree(base,ignore_errors=True)
