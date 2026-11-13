#!/usr/bin/env python3
"""Pin and safely stage official ArtCraft web releases for Lokit GitHub Pages.

No upstream binary is committed to Git; every release ZIP is checked against
the digest of its corresponding official GitHub release asset.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
PINS=ROOT/"artcraft-releases.json"
MAX_ARCHIVE=110*1024*1024
MAX_UNPACKED=400*1024*1024
MAX_MEMBER=250*1024*1024
MAX_MEMBERS=10000


def pinned_apps(path=PINS):
    registry=json.loads(Path(path).read_text(encoding="utf-8"))
    if registry.get("schema")!=1 or len(registry.get("apps",[]))!=15:
        raise ValueError("Unexpected ArtCraft release registry")
    names=set()
    for app in registry["apps"]:
        name,version,digest=app["name"],app["version"],app["sha256"]
        if (not name or not all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name)
                or name in names or not all(c in "0123456789." for c in version)
                or len(digest)!=64 or any(c not in "0123456789abcdef" for c in digest)
                or not 0<app["bytes"]<=MAX_ARCHIVE):
            raise ValueError("Invalid ArtCraft pin "+str(name))
        names.add(name)
    return registry["apps"]


def download_release(app):
    name,version=app["name"],app["version"]
    url="https://github.com/storytold/"+name+"/releases/download/v"+version+"/"+name+"-web-"+version+".zip"
    last=None
    for attempt in range(2):
        try:
            request=Request(url,headers={"User-Agent":"Lokit-ArtCraft-Verified-Web-Bundler"})
            with urlopen(request,timeout=180) as response:
                output=io.BytesIO()
                while block:=response.read(1024*1024):
                    output.write(block)
                    if output.tell()>MAX_ARCHIVE:
                        raise ValueError("ArtCraft archive exceeds the hard size limit")
            blob=output.getvalue()
            if len(blob)!=app["bytes"]:
                raise ValueError("Unexpected ArtCraft release ZIP size")
            return blob
        except (OSError,ValueError) as error:
            last=error
    raise last



def repair_photocraft_snippet_layout(staging,assets,version):
    """Repair an upstream release packaging error without modifying any original files.

    The JS module lives in app/, so its imports of './snippets/...' resolve
    under app/snippets/, while v0.17.0–v0.23.1 package only root snippets/.
    The official source and checksum-pinned ZIP remain unchanged. We add
    byte-for-byte copies of only the imported JS modules to the deployed site.
    """
    glue=staging/"app"/"photocraft-web.js"
    if not glue.is_file():
        return
    relative=set(re.findall(r"""["']\./snippets/([^"'?#]+\.js)["']""",
                            glue.read_text(encoding="utf-8")))
    if version=="0.23.1" and not relative:
        raise ValueError("PhotoCraft v0.23.1 glue has no recognizable snippet imports")
    for imported in sorted(relative):
        item=PurePosixPath(imported)
        if (item.is_absolute() or not item.parts
                or any(p in (".","..") for p in item.parts)
                or not re.fullmatch(r"[A-Za-z0-9_./-]+\.js",imported)):
            raise ValueError("Unsafe PhotoCraft snippet import: "+imported)
        source=staging.joinpath("snippets",*item.parts)
        destination=staging.joinpath("app","snippets",*item.parts)
        if destination.is_file():
            if source.is_file() and destination.read_bytes()!=source.read_bytes():
                raise ValueError("PhotoCraft snippet copies are inconsistent")
            continue
        if not source.is_file():
            raise ValueError("Missing imported PhotoCraft helper: "+imported)
        destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,destination)
        assets.append({"path":"./app/snippets/"+imported,"bytes":destination.stat().st_size})


def install_release(app,blob,target):
    """Verify ZIP and extract only safe, bounded files, then commit atomically."""
    expected=app["sha256"]
    if hashlib.sha256(blob).hexdigest()!=expected:
        raise ValueError(app["name"]+": ZIP SHA-256 mismatch")
    if len(blob)>MAX_ARCHIVE:
        raise ValueError("ZIP too large")
    target=Path(target)
    target.parent.mkdir(parents=True,exist_ok=True)
    with ZipFile(io.BytesIO(blob)) as archive:
        members=archive.infolist()
        if len(members)>MAX_MEMBERS:
            raise ValueError("ZIP has too many files")
        paths=[]
        total=0
        seen=set()
        for info in members:
            filename=info.filename
            if (not filename or "\\" in filename or filename.startswith("/")
                    or "\x00" in filename):
                raise ValueError("Unsafe ZIP member name")
            parts=PurePosixPath(filename)
            if (parts.is_absolute() or ".." in parts.parts
                    or not parts.parts or "." in parts.parts):
                raise ValueError("Unsafe ZIP member path")
            mode=stat.S_IFMT(info.external_attr>>16)
            if mode not in (0,stat.S_IFDIR,stat.S_IFREG):
                raise ValueError("ZIP contains a symlink or device")
            if info.is_dir():
                continue
            if info.file_size>MAX_MEMBER:
                raise ValueError("Oversized ArtCraft asset")
            total+=info.file_size
            if total>MAX_UNPACKED:
                raise ValueError("Unpacked ArtCraft app is too large")
            paths.append((info,parts))
        # Some upstream ZIPs use a top-level release folder, others package
        # files directly. Determine the unique root containing index.html.
        entries=[parts for _,parts in paths if parts.name=="index.html"]
        if not entries:
            raise ValueError(app["name"]+": missing index.html")
        direct=PurePosixPath("index.html")
        expected_root=PurePosixPath(app["name"]+"-web-"+app["version"])/"index.html"
        if direct in entries:
            prefix=()
        elif expected_root in entries:
            prefix=expected_root.parts[:-1]
        elif len(entries)==1:
            prefix=entries[0].parts[:-1]
        else:
            raise ValueError("Ambiguous web entry point")
        selected=[]
        for info,parts in paths:
            if prefix and parts.parts[:len(prefix)]!=prefix:
                raise ValueError("ZIP includes files outside its web root")
            rel=PurePosixPath(*parts.parts[len(prefix):])
            if not rel.parts or str(rel) in seen:
                raise ValueError("Empty or duplicate asset path")
            seen.add(str(rel))
            selected.append((info,rel))
        if "index.html" not in seen or not any(x.endswith(".wasm") for x in seen):
            raise ValueError("The release has no HTML or WASM application")
        with tempfile.TemporaryDirectory(prefix="lokit-artcraft-",dir=target.parent) as temp:
            staging=Path(temp)/app["name"]
            staging.mkdir()
            assets=[]
            for info,rel in selected:
                output=staging.joinpath(*rel.parts)
                output.parent.mkdir(parents=True,exist_ok=True)
                with archive.open(info) as source,output.open("wb") as dest:
                    shutil.copyfileobj(source,dest,1024*1024)
                assets.append({"path":"./"+str(rel),"bytes":info.file_size})
            if app["name"]=="photocraft":
                repair_photocraft_snippet_layout(staging,assets,app["version"])
            # Store accurate uncompressed sizes for byte-weighted download UI.
            assets.sort(key=lambda x:(x["path"]!="./index.html",x["path"]))
            (staging/"lokit-assets.json").write_text(json.dumps({
                "schema":1,"name":app["name"],"version":app["version"],
                "assets":assets,"totalBytes":sum(x["bytes"] for x in assets)
            },ensure_ascii=False,separators=(",",":"))+"\n",encoding="utf-8")
            if target.exists():
                shutil.rmtree(target)
            shutil.move(str(staging),str(target))
        return len(assets),sum(asset["bytes"] for asset in assets)


def process(app,output):
    data=download_release(app)
    count,size=install_release(app,data,output/app["name"])
    return app["name"],count,size


def main():
    parser=argparse.ArgumentParser(description="Stage SHA-256-pinned ArtCraft apps")
    parser.add_argument("--app",action="append",help="Install only a named app; repeatable")
    parser.add_argument("--output",type=Path,default=ROOT/"craft-apps")
    parser.add_argument("--workers",type=int,default=3)
    args=parser.parse_args()
    pinned=pinned_apps()
    if args.app:
        allowed=set(args.app)
        if not allowed.issubset({app["name"] for app in pinned}):
            parser.error("Unknown app name")
        pinned=[app for app in pinned if app["name"] in allowed]
    args.output.mkdir(parents=True,exist_ok=True)
    with ThreadPoolExecutor(max_workers=max(1,min(4,args.workers))) as pool:
        futures={pool.submit(process,app,args.output):app["name"] for app in pinned}
        for future in as_completed(futures):
            name,count,size=future.result()
            print("Verified",name,count,"files",round(size/1024/1024,2),"MiB",flush=True)


if __name__=="__main__":
    main()
