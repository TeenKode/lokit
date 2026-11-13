# PDFCraft in Lokit

Lokit includes a PDF workspace at pdf.html. Its canvas is the official,
unmodified PdfCraft WebAssembly application, loaded within a same-origin
iframe from /pdfcraft/. The web release, not the desktop program or CLI, is
used. PdfCraft remains attributed to its original authors.

Upstream: https://github.com/storytold/pdfcraft
Pinned upstream version: v0.21.1
Official artifact: pdfcraft-web-0.21.1.zip
SHA-256: fe9708d46af191aebb56f70eb32cf8b112b0b9452d17ae6ba3a8c4a8665fe748

## Building and publishing

The source repository does not commit approximately 34 MB of upstream binary
release assets. Run:

    python scripts/vendor-pdfcraft.py
    python tests/test-pdfcraft.py

The script downloads only the pinned official release, verifies the complete
archive against a fixed SHA-256 digest, checks for unsafe ZIP entries and
extracts it to pdfcraft/. That directory is excluded from Git.

The GitHub Pages deployment workflow fetches this release again and publishes
it with Lokit under the same origin, including the browser OCR models and all
upstream licence notices. In repository Settings -> Pages, select GitHub
Actions as the build/deployment source. A branch-based Pages deployment that
only publishes the source tree will NOT contain the generated PDFCraft assets.

For local development, use a static HTTP server in the repository root,
after running the vendoring script. Do not open the page with file://.

## Features and limitations

The full *web build* is offered via its own native UI: document viewing,
search, organizing and rotating pages, combine/split, comments, forms,
redaction, document protection, available digital-signing, OCR and the
other commands implemented upstream in the browser. Some PdfCraft features
are desktop-only: native filesystem interactions, CLI/MCP tooling, native
printing, native signature-token handling and related host integrations.
Lokit does not claim parity with the desktop version or Acrobat.

The native web interface is kept intact. The PdfCraft release is not patched
or rebranded, and its ArtCraft marks are used only within the original
application, never as Lokit branding.

## Offline mode

The Lokit service worker caches PdfCraft resources on use. In the PDF page,
select "Сохранить для офлайна" to additionally cache every asset from
offline-assets.json, including OCR models. Explicit prefetch requests bypass
the service worker's cache writer, avoiding simultaneous Cache.put attempts.
The page reads each response fully into memory before saving it in Cache Storage.
Successfully saved resources are reused across retries. Failures display the
filename, so the user can repeat the operation without redownloading earlier
assets. The service worker aliases /pdfcraft/ to cached /pdfcraft/index.html.

Browser storage quotas can still prevent complete caching, and private/incognito
modes may discard the cache. The page requests persistent storage where the
browser supports it, but permission is not guaranteed. The first download
still needs network access. A browser with WebGPU or WebGL2
and modern WASM support is required; upstream also offers a CPU fallback flag.

## Licences

PdfCraft application code is MIT OR Apache-2.0. The official ZIP includes
LICENSE-MIT, LICENSE-APACHE, NOTICE and third-party attribution documents;
OCR models and other bundled assets keep their own licence terms.
ArtCraft marks are not open-source. If PdfCraft itself is modified,
its special brand licence requires removal of ArtCraft branding.

Security: only pinned SHA-256-verified upstream binaries are included,
the archive is path/symlink/bomb checked, and PDF data is processed locally.
