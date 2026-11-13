"""Unit tests for pinned and safe PdfCraft Web release packaging."""
import hashlib
from io import BytesIO
from pathlib import Path
import stat
import tempfile
import zipfile
import importlib.util

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vendor_pdfcraft", root / "scripts" / "vendor-pdfcraft.py")
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)


def make_zip(extra=None, external_attr=None):
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as z:
        base = vendor.PACKAGE + "/"
        for name in ("index.html", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "worker_bg.wasm"):
            z.writestr(base + name, '<canvas id="pdfcraft"></canvas>' if name == "index.html" else "test")
        if extra:
            entry = zipfile.ZipInfo(extra)
            if external_attr is not None:
                entry.external_attr = external_attr
            z.writestr(entry, "malicious")
    return output.getvalue()


with tempfile.TemporaryDirectory() as folder:
    dest = Path(folder) / "pdfcraft"
    blob = make_zip()
    expected = hashlib.sha256(blob).hexdigest()
    assert vendor.install_release(blob, dest, expected) == 5
    assert (dest / "index.html").is_file()
    assert (dest / "LICENSE-MIT").is_file()
    import json
    manifest = json.loads((dest / "offline-assets.json").read_text())
    assert manifest["version"] == vendor.VERSION
    assert "./index.html" in manifest["files"]
    assert "./worker_bg.wasm" in manifest["files"]
    assert "./offline-assets.json" in manifest["files"]
    try:
        vendor.install_release(blob, dest, "0" * 64)
        raise AssertionError("Unexpected acceptance of incorrect SHA")
    except ValueError as error:
        assert "SHA-256" in str(error)
    assert (dest / "index.html").exists(), "Failed update must not destroy the previous release"
    for evil in (vendor.PACKAGE + "/../escape.txt", "../other/escape.txt", "/absolute.txt"):
        bad = make_zip(evil)
        try:
            vendor.install_release(bad, dest, hashlib.sha256(bad).hexdigest())
            raise AssertionError("Unexpected acceptance of unsafe path " + evil)
        except ValueError:
            pass
    link = make_zip(vendor.PACKAGE + "/link", (stat.S_IFLNK | 0o777) << 16)
    try:
        vendor.install_release(link, dest, hashlib.sha256(link).hexdigest())
        raise AssertionError("Unexpected acceptance of symlink")
    except ValueError:
        pass
    assert (dest / "index.html").is_file(), "Rejected updates must leave installed data intact"

page = (root / "pdf.html").read_text()
script = (root / "js" / "pdf-page.js").read_text()
sw = (root / "sw.js").read_text()
assert 'src="./pdfcraft/"' not in page, "Frame must wait for deployment verification"
assert "new URL('index.html', root)" in script
assert "pdfcraft/" in sw
assert "'./pdf.html'" in sw and "'./js/pdf-page.js'" in sw
assert "PDF" in (root / "js" / "app.js").read_text()
print("PdfCraft integration: ZIP verification, safe extraction, offline manifest, navigation — PASS")
