#!/usr/bin/env python3
"""Install the exact upstream PdfCraft web release for Lokit's static site.

Uses the official, unmodified release rather than copying Rust app sources.
All paths are checked before extraction; neither an unpinned "latest" download
nor a substitute binary can silently change the distributed application.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from urllib.request import Request, urlopen
from zipfile import ZipFile, BadZipFile

VERSION = "0.21.1"
PACKAGE = "pdfcraft-web-" + VERSION
URL = "https://github.com/storytold/pdfcraft/releases/download/v" + VERSION + "/" + PACKAGE + ".zip"
SHA256 = "fe9708d46af191aebb56f70eb32cf8b112b0b9452d17ae6ba3a8c4a8665fe748"
MAX_ZIP = 60 * 1024 * 1024
MAX_UNPACKED = 250 * 1024 * 1024
MAX_FILES = 1000


def download_release():
    request = Request(URL, headers={"User-Agent": "Lokit-PdfCraft-Pinned-Vendor"})
    with urlopen(request, timeout=120) as response:
        chunks = []
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_ZIP:
                raise ValueError("PDFCraft archive is larger than the allowed limit")
            chunks.append(chunk)
    return b"".join(chunks)


def install_release(blob, target, expected_sha256=SHA256):
    """Verify archive and safely extract a self-contained static site."""
    actual = hashlib.sha256(blob).hexdigest()
    if actual != expected_sha256:
        raise ValueError("PDFCraft SHA-256 mismatch: " + actual)
    if len(blob) > MAX_ZIP:
        raise ValueError("PDFCraft ZIP exceeds the allowed size")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(io.BytesIO(blob)) as archive:
        entries = []
        names = set()
        total = 0
        for member in archive.infolist():
            parts = PurePosixPath(member.filename)
            if (parts.is_absolute() or ".." in parts.parts or
                    not parts.parts or parts.parts[0] != PACKAGE):
                raise ValueError("Unexpected path in PDFCraft release")
            mode = member.external_attr >> 16
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                raise ValueError("PDFCraft release contains a symlink")
            if member.is_dir():
                continue
            relative = PurePosixPath(*parts.parts[1:])
            if not relative.parts or str(relative) in names:
                raise ValueError("Invalid or duplicate path in PDFCraft release")
            names.add(str(relative))
            total += member.file_size
            if total > MAX_UNPACKED or len(names) > MAX_FILES:
                raise ValueError("PDFCraft release exceeds extraction limits")
            entries.append((member, relative))
        required = {"index.html", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"}
        if not required.issubset(names):
            raise ValueError("PDFCraft release has no page or required legal notices")
        if not any(path.endswith(".wasm") for path in names):
            raise ValueError("PDFCraft WebAssembly binary is missing")
        with tempfile.TemporaryDirectory(prefix="lokit-pdfcraft-", dir=target.parent) as tmp:
            staging = Path(tmp) / "pdfcraft"
            staging.mkdir()
            for info, relative in entries:
                output = staging.joinpath(*relative.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, output.open("wb") as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
            # URLs remain relative to /pdfcraft/, including OCR models.
            manifest = ["./" + name for name in sorted(names)]
            manifest.append("./offline-assets.json")
            (staging / "offline-assets.json").write_text(
                json.dumps({"version": VERSION, "files": manifest}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            if target.exists():
                shutil.rmtree(target)
            shutil.move(str(staging), str(target))
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description="Vendor PdfCraft WebAssembly release with SHA-256 verification")
    parser.add_argument("--archive", type=Path, help="Use a previously downloaded ZIP (still hash-checked)")
    parser.add_argument("--output", type=Path, default=Path("pdfcraft"), help="Destination folder")
    args = parser.parse_args()
    blob = args.archive.read_bytes() if args.archive else download_release()
    count = install_release(blob, args.output)
    print("Installed PdfCraft v" + VERSION + " (" + str(count) + " files) at " + str(args.output))


if __name__ == "__main__":
    main()
