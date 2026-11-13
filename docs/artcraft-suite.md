# ArtCraft Web suite in Lokit

15 official, unmodified ArtCraft WebAssembly releases are integrated into
Lokit's tool catalog via \`craft.html?app=<name>\`. PDFCraft remains a separate
integration at \`pdf.html\`.

Source org: https://github.com/storytold
Release lockfile: [artcraft-releases.json](../artcraft-releases.json)
Each lock entry contains the exact official GitHub release version, archive
size and SHA-256. This prevents silent changes in published executables.

## Included apps

PhotoCraft (photography), VectorCraft (SVG/vector drawing), FilmCraft (video),
LightCraft (RAW/catalog), EffectCraft (motion graphics), DesignCraft (layouts),
FigCraft (UI design), TextureCraft (texture painting), MaterialCraft (materials),
SoundCraft (DAW), WordCraft (documents), DeckCraft (presentations), CADCraft
(CAD), GridCraft (spreadsheets), and Craft Anything (software projects).
AniCraft is **not** included because the latest checked release does not
publish a ready-made web archive.

## Build and GitHub Pages deployment

    python tests/test-artcraft.py
    node tests/test-artcraft.mjs
    python scripts/vendor-artcraft.py --workers 3
    python scripts/verify-artcraft-bundles.py

The deployment workflow repeats verification, assembles \`craft-apps/<name>/\`
and publishes 15 subdirectories alongside Lokit. The verified ZIPs are never
checked into the repository. Setup: Settings > Pages > Source = GitHub Actions.
The legacy branch-mode publishing cannot include downloaded binaries.
Raw, uncompressed assets consume much more disk space than ZIP sizes; GitHub
Pages size and per-file limits must be respected.

\`vendor-artcraft.py\` downloads official release ZIPs, pins hashes, bounds
individual and total asset sizes, rejects symlinks, absolute paths, duplicate
paths and traversal, and extracts each bundle to a staging directory before
replacement. \`lokit-assets.json\` is generated with the actual decompressed
asset length for the browser download progress screen.

## Loading and caching

Each tool opens \`craft.html?app=<name>\` with a responsive progress overlay.
Only that chosen editor is downloaded. The progress bar measures downloaded
**uncompressed bytes** across the actual release assets, not an arbitrary timer.
A count of files and the filename currently being downloaded are also shown.
Once assets are cached, the original index.html loads inside an iframe.

The Service Worker serves a separate cache for each app, including an alias
for the directory entry URL and index.html. Prefetch requests bypass the
Service Worker cache writer, avoiding competing Cache.put operations.
Incomplete downloads are resumable: previously saved resources are reused
and network fetches retry once. The "Open without saving" button cancels
prefetch and launches the unmodified editor directly; this can still need
the internet for assets not already cached. Storage quotas or browser
private-mode eviction can prevent a complete offline copy. No documents are
persisted by the Lokit loader; the upstream application may persist its own
work using browser storage.

"100%" means the static bundle has downloaded and been cached, not that the
editor has finished initializing WASM or that every native function works
in a browser. During WASM initialization the loader shows an indeterminate
status until the iframe document load event.

## Compatibility, third-party services and licences

Hosting needs HTTPS or localhost for WebGPU, WebAssembly, clipboard and
workers where supported. PhotoCraft uses a chunked bootloader. LightCraft
uses OPFS / IndexedDB for its photo library; users should export library
backups before clearing site data. FigCraft collaboration and Craft Anything
agent features may connect to external services; they should not be described
as fully offline or private without verifying each activity. Features
available only in native / CLI builds remain unavailable in the web release.

ArtCraft code is MIT OR Apache-2.0 with separate ArtCraft mark restrictions.
The upstream web archives, attribution and legal files remain intact and are
served under their own brand. Lokit supplies only the launch screen, catalog
integration and local asset caching, not a rebranding or modification of
upstream binaries.

Security note: the browser can access all same-origin applications' storage.
These are official third-party applications: their published source and
runtime behavior should be audited for external calls before handling
sensitive data.

## Russian interface

Lokit applies native Russian interface settings through `js/craft-language.js`.
It does not patch upstream binaries or claim that a canvas was translated by
browser translation. 11 ArtCraft releases have Russian catalogs; the other
four (SoundCraft, DeckCraft, TextureCraft, MaterialCraft) do not. Further
information and the manual language switch fallback for some editors are
in [Russian localization status](russian-locale.md).
