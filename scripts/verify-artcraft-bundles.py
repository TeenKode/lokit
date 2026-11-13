#!/usr/bin/env python3
"""Check every published ArtCraft app is present and its manifest is accurate."""
import json
import re
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

ROOT=Path(__file__).resolve().parents[1]
spec=spec_from_file_location("vendor_artcraft",ROOT/"scripts"/"vendor-artcraft.py")
vendor=module_from_spec(spec)
spec.loader.exec_module(vendor)
total=0
for pin in vendor.pinned_apps():
    name=pin["name"]
    folder=ROOT/"craft-apps"/name
    if not (folder/"index.html").is_file():
        raise SystemExit("Missing ArtCraft entry: "+name)
    manifest=json.loads((folder/"lokit-assets.json").read_text(encoding="utf-8"))
    if manifest["schema"]!=1 or manifest["version"]!=pin["version"] or manifest["name"]!=name:
        raise SystemExit("Incorrect release manifest: "+name)
    files=manifest["assets"]
    if not files or not any(p["path"].endswith(".wasm") for p in files):
        raise SystemExit("Missing WASM assets: "+name)
    count=0
    seen=set()
    for asset in files:
        path=asset["path"]
        if not path.startswith("./") or path in seen:
            raise SystemExit("Invalid path: "+path)
        seen.add(path)
        file=folder/path.removeprefix("./")
        if not file.is_file() or file.stat().st_size!=asset["bytes"]:
            raise SystemExit("Missing or changed ArtCraft resource: "+str(file))
        count+=asset["bytes"]
    if name=="photocraft":
        # The official v0.23.1 ZIP lacks the relative app/snippets/ import
        # target. It is a known upstream packaging defect, not a runtime
        # problem with WebAssembly. Verify every deployed import before Pages.
        glue=folder/"app"/"photocraft-web.js"
        if glue.is_file():
            names=set(re.findall(r"""["']\./snippets/([^"'?#]+\.js)["']""",
                                 glue.read_text(encoding="utf-8")))
            if pin["version"]=="0.23.1" and not names:
                raise SystemExit("PhotoCraft expected snippet imports not found")
            for rel in names:
                path="./app/snippets/"+rel
                target=folder/path[2:]
                if not target.is_file() or path not in seen:
                    raise SystemExit("PhotoCraft unresolved JS import: "+path)
                original=folder/"snippets"/rel
                if original.is_file() and target.read_bytes()!=original.read_bytes():
                    raise SystemExit("PhotoCraft copied JS differs from release: "+path)
    if count!=manifest["totalBytes"]:
        raise SystemExit("Invalid total size: "+name)
    total+=count
    print(name,pin["version"],len(files),"files",f"{count/1024/1024:.1f} MiB")
if total>1000*1024*1024:
    raise SystemExit("Total ArtCraft assets exceed 1000 MiB, too large for GitHub Pages")
print("Verified all 15 ArtCraft bundles:",f"{total/1024/1024:.1f} MiB")
