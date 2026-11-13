"""ArtCraft pin registry and safe release extraction without network."""
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile, ZipInfo
from importlib.util import spec_from_file_location,module_from_spec
import hashlib
import json
import stat
import tempfile

ROOT=Path(__file__).resolve().parents[1]
spec=spec_from_file_location("vendor_artcraft",ROOT/"scripts"/"vendor-artcraft.py")
vendor=module_from_spec(spec)
spec.loader.exec_module(vendor)
pins=vendor.pinned_apps()
assert len(pins)==15 and len({x["name"] for x in pins})==15
assert sum(x["bytes"] for x in pins)>250_000_000
assert {x["name"] for x in pins}=={
 "photocraft","vectorcraft","filmcraft","lightcraft","effectcraft",
 "designcraft","figcraft","texturecraft","materialcraft","soundcraft",
 "wordcraft","deckcraft","cadcraft","gridcraft","craft-anything"
}
sample=dict(pins[0])
pref=sample["name"]+"-web-"+sample["version"]+"/"


def build_zip(prefix=pref,extra=None,symlink=False):
    output=BytesIO()
    with ZipFile(output,"w") as z:
        z.writestr(prefix+"index.html","<!doctype html><title>Editor</title>")
        z.writestr(prefix+"app_bg.wasm",b"\0asm"+bytes(range(8)))
        z.writestr(prefix+"LICENSE-MIT","license")
        if extra:
            entry=ZipInfo(extra)
            if symlink:entry.external_attr=(stat.S_IFLNK|0o777)<<16
            z.writestr(entry,"unsafe")
    return output.getvalue()


with tempfile.TemporaryDirectory() as folder:
    dest=Path(folder)/"photocraft"
    blob=build_zip()
    sample["sha256"]=hashlib.sha256(blob).hexdigest()
    count,total=vendor.install_release(sample,blob,dest)
    assert count==3 and total>0
    assert (dest/"index.html").is_file()
    manifest=json.loads((dest/"lokit-assets.json").read_text())
    assert manifest["schema"]==1 and manifest["name"]==sample["name"]
    assert manifest["totalBytes"]==sum(x["bytes"] for x in manifest["assets"])
    assert {x["path"] for x in manifest["assets"]}=={
       "./index.html","./app_bg.wasm","./LICENSE-MIT"
    }
    assert vendor.install_release(sample,blob,dest)[0]==3
    try:
        vendor.install_release({**sample,"sha256":"0"*64},blob,dest)
        raise AssertionError("Accepted incorrect ZIP checksum")
    except ValueError as error:
        assert "SHA-256" in str(error)
    for path in (pref+"../outside.txt","../outside.txt","/root.txt",pref+"link"):
        bad=build_zip(extra=path,symlink=path.endswith("link"))
        try:
            vendor.install_release({**sample,"sha256":hashlib.sha256(bad).hexdigest()},bad,dest)
            raise AssertionError("Accepted unsafe member: "+path)
        except ValueError:pass
    assert (dest/"index.html").exists(),"Rejected update destroyed current bundle"
    plain=build_zip(prefix="")
    sample["sha256"]=hashlib.sha256(plain).hexdigest()
    assert vendor.install_release(sample,plain,Path(folder)/"rootless")[0]==3

code=(ROOT/"js"/"craft-page.js").read_text()
sw=(ROOT/"sw.js").read_text()
assert "craft-apps/" in code and "craft-apps/" in sw
assert "lokit-craft-prefetch" in code or "craft-loader" in code
assert "'./craft.html'" in sw and "'./js/craft-loader.js'" in sw
assert (ROOT/"craft.html").is_file() and (ROOT/"craft.css").is_file()
print("ArtCraft: 15 pinned releases, verified ZIP extraction, traversal/symlink rejection, loader wiring — PASS")
