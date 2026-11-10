/**
 * WebmCopyTrim — a lossless (`-c copy`) cut of a WebM / Matroska file, done as
 * bookkeeping over the source's own bytes: read the EBML skeleton, find the
 * keyframes (from Cues when the file has them, from a block scan otherwise),
 * plan the window, and hand back a File whose body is the source's clusters —
 * middle clusters as byte ranges of the source, only the two edge clusters
 * rebuilt block by block. No demuxer, no re-mux, no WASM, no memory ceiling.
 *
 * Why this exists (2026-09-17): one take in six on /screen-recorder is WebM
 * (RU, 30 d: 356 sessions — Yandex Browser has no H.264 encoder, so the
 * recorder encodes VP9/Opus through webm-muxer), and the inline trim was
 * «mp4 only: WebM would need FFmpeg, deferred» — those takes average 13 min /
 * 188 MB and run to 4.3 GB, past what an FFmpeg-WASM copy (MEMFS output, one
 * JS buffer, 2 GiB wall) can hand back. Mp4CopyTrim solved the same shape
 * for mp4 the day before; this is the same door for the other container.
 *
 * API — window.WebmCopyTrim
 *   run(file, startSec, endSec)  → Promise<File>   (`.trimInfo` = {startMs,
 *       endMs, durationMs, parts, size, tracks, container:'webm'});
 *       the cut opens on the last video keyframe ≤ startSec and closes at the
 *       last block ≤ endSec, both tracks; the file's clock restarts at 0.
 *       Throws an Error with `code`: 'not-webm' | 'no-segment' | 'no-tracks'
 *       | 'no-keyframes' | 'empty-range' | 'no-samples-in-range' | 'bad-ebml'.
 *   keyframeTimes(file)          → Promise<number[]>  seconds, video keyframes
 *   inspect(file)                → Promise<{durationMs, timecodeScale, tracks, keyframes, cues}>
 *   isWebm(blob)                 → boolean (by MIME or name)
 *
 * Layout notes (measured on webm-muxer takes and ffmpeg/libwebm output):
 *   - the Cluster Timecode is the first child; SimpleBlock/BlockGroup relative
 *     timecodes are int16 against it; Cues carry CueTime + CueClusterPosition
 *     (relative to the Segment data start) — for a keyframe that sits INSIDE a
 *     cluster (ffmpeg with cluster_time_limit < GOP) the cue still names that
 *     cluster, so the keyframe block is found by walking the cluster;
 *   - a live/streamed file (MediaRecorder, ffmpeg -live) has an unknown-size
 *     Segment, may have unknown-size Clusters and no Cues — clusters are then
 *     walked to the end and keyframes come from the block flags;
 *   - output: EBML header (copied) · Segment (sized) · Info (TimecodeScale,
 *     Duration, apps) · Tracks (copied) · Cues (rebuilt, fixed-width, placed
 *     BEFORE the clusters like a faststart moov) · Clusters.
 */
(function () {
'use strict';
if (window.WebmCopyTrim) return;

var ID = {
    EBML: 0x1A45DFA3, SEGMENT: 0x18538067, SEEKHEAD: 0x114D9B74, INFO: 0x1549A966, TRACKS: 0x1654AE6B,
    CLUSTER: 0x1F43B675, CUES: 0x1C53BB6B, TAGS: 0x1254C367, CHAPTERS: 0x1043A770, ATTACHMENTS: 0x1941A469, VOID: 0xEC,
    TIMECODE: 0xE7, SIMPLEBLOCK: 0xA3, BLOCKGROUP: 0xA0, BLOCK: 0xA1, REFERENCEBLOCK: 0xFB, BLOCKDURATION: 0x9B,
    TIMECODESCALE: 0x2AD7B1, DURATION: 0x4489, MUXINGAPP: 0x4D80, WRITINGAPP: 0x5741,
    TRACKENTRY: 0xAE, TRACKNUMBER: 0xD7, TRACKTYPE: 0x83, CODECID: 0x86,
    SEEK: 0x4DBB, SEEKID: 0x53AB, SEEKPOSITION: 0x53AC,
    CUEPOINT: 0xBB, CUETIME: 0xB3, CUETRACKPOSITIONS: 0xB7, CUETRACK: 0xF7, CUECLUSTERPOSITION: 0xF1,
    CODECPRIVATE: 0x63A2, VIDEO: 0xE0, PIXELWIDTH: 0xB0, PIXELHEIGHT: 0xBA, CONTENTENCODINGS: 0x6D80,
    AUDIO: 0xE1, SAMPLINGFREQ: 0xB5, OUTSAMPLINGFREQ: 0x78B5, CHANNELS: 0x9F, BITDEPTH: 0x6264,
    DEFAULTDURATION: 0x23E383, CODECDELAY: 0x56AA
};
var TOPLEVEL = {};
[ID.SEGMENT, ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.TAGS, ID.CHAPTERS, ID.ATTACHMENTS].forEach(function (i) { TOPLEVEL[i] = true; });

var WINDOW = 64 * 1024;
var SCAN_WINDOW = 8 * 1024 * 1024;

function typed(code, msg) { var e = new Error('webm-copy-trim: ' + (msg || code)); e.code = code; return e; }

function isWebm(blob) {
    if (!blob) return false;
    var t = String(blob.type || '').toLowerCase();
    if (/^(video|audio)\/(webm|x-matroska|matroska)/.test(t)) return true;
    var n = String(blob.name || '').toLowerCase();
    return /\.(webm|mkv|mka)$/.test(n);
}

/* ── windowed reader over a Blob ───────────────────────────────────────── */
function Reader(file) { this.file = file; this.size = file.size; this.win = []; this.reads = 0; this.readBytes = 0; }
Reader.prototype.bytes = async function (at, len) {
    if (at < 0) at = 0;
    if (at + len > this.size) len = Math.max(0, this.size - at);
    for (var i = 0; i < this.win.length; i++) {
        var w = this.win[i];
        if (at >= w.at && at + len <= w.at + w.u8.length) return w.u8.subarray(at - w.at, at - w.at + len);
    }
    var wlen = Math.max(len, WINDOW), wat = at;
    var u8 = new Uint8Array(await this.file.slice(wat, Math.min(this.size, wat + wlen)).arrayBuffer());
    this.reads++; this.readBytes += u8.length;
    this.win.unshift({ at: wat, u8: u8 });
    if (this.win.length > 6) this.win.pop();
    return u8.subarray(0, len);
};

/* ── EBML primitives ──────────────────────────────────────────────────── */
function vintLen(first) { var len = 1, mask = 0x80; while (len <= 8 && (first & mask) === 0) { len++; mask >>= 1; } return len; }
function readIdAt(u8, o) {
    if (o >= u8.length) return null;
    var len = vintLen(u8[o]);
    if (len > 4 || o + len > u8.length) return null;
    var v = 0; for (var i = 0; i < len; i++) v = v * 256 + u8[o + i];
    return { id: v, len: len };
}
function readSizeAt(u8, o) {
    if (o >= u8.length) return null;
    var len = vintLen(u8[o]);
    if (len > 8 || o + len > u8.length) return null;
    var mask = 0x80 >> (len - 1);
    var v = u8[o] & (mask - 1), unknown = (v === mask - 1);
    for (var i = 1; i < len; i++) { v = v * 256 + u8[o + i]; if (u8[o + i] !== 0xFF) unknown = false; }
    return { size: unknown ? -1 : v, len: len };
}
function readUint(u8, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + u8[o + i]; return v; }
function readFloat(u8, o, n) {
    var dv = new DataView(u8.buffer, u8.byteOffset + o, n);
    return n === 8 ? dv.getFloat64(0) : (n === 4 ? dv.getFloat32(0) : 0);
}
function readInt16(u8, o) { var v = (u8[o] << 8) | u8[o + 1]; return v & 0x8000 ? v - 0x10000 : v; }

// element header at `at` (reads at most 12 bytes)
async function header(r, at) {
    var u8 = await r.bytes(at, 12);
    if (u8.length < 2) return null;
    var id = readIdAt(u8, 0); if (!id) return null;
    var sz = readSizeAt(u8, id.len); if (!sz) return null;
    return { id: id.id, at: at, dataAt: at + id.len + sz.len, size: sz.size, hdrLen: id.len + sz.len };
}

/* ── encoding helpers (fixed width, so sizes are known before positions) ── */
function encId(id) { var b = []; while (id > 0) { b.unshift(id & 0xFF); id = Math.floor(id / 256); } return b; }
function encSize8(n) { var b = new Array(8); b[0] = 0x01; for (var i = 7; i >= 1; i--) { b[i] = n & 0xFF; n = Math.floor(n / 256); } return b; }
function encUint8(n) { var b = new Array(8); for (var i = 7; i >= 0; i--) { b[i] = n & 0xFF; n = Math.floor(n / 256); } return b; }
function el(id, payloadBytes) { var out = encId(id).concat(encSize8(payloadBytes.length)); return out.concat(payloadBytes); }
function elUint(id, n) { return el(id, encUint8(n)); }
function elFloat(id, f) { var b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, f); return el(id, Array.prototype.slice.call(b)); }
function concatBytes(arrs) { var n = 0, i; for (i = 0; i < arrs.length; i++) n += arrs[i].length; var out = new Uint8Array(n), o = 0; for (i = 0; i < arrs.length; i++) { out.set(arrs[i], o); o += arrs[i].length; } return out; }

/* ── model ──────────────────────────────────────────────────────────────── */
async function readModel(file) {
    var r = new Reader(file);
    var eb = await header(r, 0);
    if (!eb || eb.id !== ID.EBML) throw typed('not-webm', 'no EBML header');
    if (eb.size < 0) throw typed('bad-ebml', 'EBML header of unknown size');
    var ebmlBytes = new Uint8Array(await r.bytes(0, eb.dataAt + eb.size)); // copied
    var seg = await header(r, eb.dataAt + eb.size);
    if (!seg || seg.id !== ID.SEGMENT) throw typed('no-segment', 'no Segment after the EBML header');
    var segDataAt = seg.dataAt, segEnd = seg.size < 0 ? file.size : Math.min(file.size, seg.dataAt + seg.size);

    var m = { r: r, ebml: ebmlBytes, segDataAt: segDataAt, segEnd: segEnd, segSized: seg.size >= 0, timecodeScale: 1000000, durationTicks: null,
              apps: [], tracks: [], tracksBytes: null, videoTrack: null, cuesAt: null, firstClusterAt: null, clusters: null, keyframes: null, hasCues: false };

    // Segment children up to the first Cluster
    var at = segDataAt;
    while (at < segEnd) {
        var h = await header(r, at);
        if (!h) throw typed('bad-ebml', 'unreadable element at ' + at);
        if (h.id === ID.CLUSTER) { m.firstClusterAt = at; break; }
        if (h.size < 0) throw typed('bad-ebml', 'unknown-size element before the first cluster');
        var body = await r.bytes(h.dataAt, Math.min(h.size, 1 << 20));
        if (h.id === ID.INFO) parseInfo(m, body);
        else if (h.id === ID.TRACKS) { m.tracksBytes = new Uint8Array(await r.bytes(h.at, h.hdrLen + h.size)); parseTracks(m, body); }
        else if (h.id === ID.SEEKHEAD) parseSeekHead(m, body);
        else if (h.id === ID.CUES) m.cuesAt = h.at;
        at = h.dataAt + h.size;
    }
    if (m.firstClusterAt === null) throw typed('no-samples-in-range', 'no clusters');
    if (!m.tracksBytes || !m.tracks.length) throw typed('no-tracks', 'no Tracks element');
    if (m.videoTrack === null) m.videoTrack = m.tracks[0].number;
    /* An audio-only file is cut on its audio track, and every audio block is a
       sync point whether or not the writer set the keyframe bit: Firefox's
       MediaRecorder leaves it clear on every Opus block (measured 13.10.2026,
       Firefox 148 — flags 0x00 throughout), and such a take read as «no
       keyframes» although any block of it can open a cut. */
    for (var ti = 0; ti < m.tracks.length; ti++) if (m.tracks[ti].number === m.videoTrack && m.tracks[ti].type === 2) m.refIsAudio = true;

    // keyframes: Cues (fast path — only the named clusters are touched) or a block scan
    if (m.cuesAt !== null) await readCues(m);
    if (!m.keyframes || !m.keyframes.length) await scanAllClusters(m);
    if (!m.keyframes.length) throw typed('no-keyframes', 'no video keyframes found');
    return m;
}

function children(u8, start, end, cb) {
    var o = start;
    while (o < end) {
        var id = readIdAt(u8, o); if (!id) return;
        var sz = readSizeAt(u8, o + id.len); if (!sz) return;
        var dataAt = o + id.len + sz.len;
        var size = sz.size < 0 ? end - dataAt : sz.size;
        if (cb(id.id, o, dataAt, size) === false) return;
        o = dataAt + size;
        if (sz.size < 0) return;
    }
}
function parseInfo(m, u8) {
    children(u8, 0, u8.length, function (id, at, dataAt, size) {
        if (id === ID.TIMECODESCALE) m.timecodeScale = readUint(u8, dataAt, size);
        else if (id === ID.DURATION) m.durationTicks = readFloat(u8, dataAt, size);
        else if (id === ID.MUXINGAPP || id === ID.WRITINGAPP) m.apps.push({ id: id, bytes: Array.prototype.slice.call(u8.subarray(dataAt, dataAt + size)) });
    });
}
function parseTracks(m, u8) {
    children(u8, 0, u8.length, function (id, at, dataAt, size) {
        if (id !== ID.TRACKENTRY) return;
        var t = { number: null, type: null, codec: '', codecPrivate: null, width: 0, height: 0, encoded: false,
                  sampleRate: 0, outSampleRate: 0, channels: 0, bitDepth: 0, defaultDurationNs: 0, codecDelayNs: 0 };
        children(u8, dataAt, dataAt + size, function (cid, cat, cdat, csz) {
            if (cid === ID.TRACKNUMBER) t.number = readUint(u8, cdat, csz);
            else if (cid === ID.TRACKTYPE) t.type = readUint(u8, cdat, csz);
            else if (cid === ID.CODECID) t.codec = String.fromCharCode.apply(null, u8.subarray(cdat, cdat + csz));
            else if (cid === ID.CODECPRIVATE) t.codecPrivate = u8.slice(cdat, cdat + csz);   // a copy: `u8` is a reader window
            else if (cid === ID.CONTENTENCODINGS) t.encoded = true;
            else if (cid === ID.DEFAULTDURATION) t.defaultDurationNs = readUint(u8, cdat, csz);
            else if (cid === ID.CODECDELAY) t.codecDelayNs = readUint(u8, cdat, csz);
            else if (cid === ID.AUDIO) children(u8, cdat, cdat + csz, function (aid, aat, adat, asz) {
                if (aid === ID.SAMPLINGFREQ) t.sampleRate = readFloat(u8, adat, asz);
                else if (aid === ID.OUTSAMPLINGFREQ) t.outSampleRate = readFloat(u8, adat, asz);
                else if (aid === ID.CHANNELS) t.channels = readUint(u8, adat, asz);
                else if (aid === ID.BITDEPTH) t.bitDepth = readUint(u8, adat, asz);
            });
            else if (cid === ID.VIDEO) children(u8, cdat, cdat + csz, function (vid, vat, vdat, vsz) {
                if (vid === ID.PIXELWIDTH) t.width = readUint(u8, vdat, vsz);
                else if (vid === ID.PIXELHEIGHT) t.height = readUint(u8, vdat, vsz);
            });
        });
        if (t.number !== null) { m.tracks.push(t); if (t.type === 1 && m.videoTrack === null) m.videoTrack = t.number; }
    });
}
function parseSeekHead(m, u8) {
    children(u8, 0, u8.length, function (id, at, dataAt, size) {
        if (id !== ID.SEEK) return;
        var sid = null, pos = null;
        children(u8, dataAt, dataAt + size, function (cid, cat, cdat, csz) {
            if (cid === ID.SEEKID) sid = readUint(u8, cdat, csz);
            else if (cid === ID.SEEKPOSITION) pos = readUint(u8, cdat, csz);
        });
        if (sid === ID.CUES && pos !== null) m.cuesAt = m.segDataAt + pos;
    });
}
async function readCues(m) {
    var h = await header(m.r, m.cuesAt);
    if (!h || h.id !== ID.CUES || h.size < 0) return;
    var u8 = await m.r.bytes(h.dataAt, h.size);
    var kfs = [];
    children(u8, 0, u8.length, function (id, at, dataAt, size) {
        if (id !== ID.CUEPOINT) return;
        var t = null, pos = null, trk = null;
        children(u8, dataAt, dataAt + size, function (cid, cat, cdat, csz) {
            if (cid === ID.CUETIME) t = readUint(u8, cdat, csz);
            else if (cid === ID.CUETRACKPOSITIONS) children(u8, cdat, cdat + csz, function (pid, pat, pdat, psz) {
                if (pid === ID.CUETRACK) trk = readUint(u8, pdat, psz);
                else if (pid === ID.CUECLUSTERPOSITION) pos = readUint(u8, pdat, psz);
            });
        });
        if (t === null || pos === null) return;
        kfs.push({ t: t, clusterAt: m.segDataAt + pos, track: trk });
    });
    // one point per cluster, the earliest time; video-track points win over other tracks' points
    var byCluster = {};
    for (var i = 0; i < kfs.length; i++) { var k = kfs[i], have = byCluster[k.clusterAt]; if (!have || (k.track === m.videoTrack && have.track !== m.videoTrack) || (k.track === have.track && k.t < have.t)) byCluster[k.clusterAt] = k; }
    kfs = Object.keys(byCluster).map(function (key) { return byCluster[key]; });
    kfs.sort(function (a, b) { return a.t - b.t; });
    if (kfs.length) { m.keyframes = kfs; m.hasCues = true; }
}

// Walk clusters from `from` (headers only when sizes are known; block-level
// when a cluster's size is unknown). With `scan`, every block header is read
// and video keyframes are collected. With `until`, the walk stops after the
// first cluster whose timecode passes it.
async function walkClusters(m, from, opts) {
    opts = opts || {};
    var out = [], at = from, kfs = [];
    while (at < m.segEnd) {
        var h = await header(m.r, at);
        if (!h) break;
        if (h.id !== ID.CLUSTER) {
            if (h.size < 0) break;
            if (TOPLEVEL[h.id] || h.id === ID.VOID) { at = h.dataAt + h.size; continue; }
            break;
        }
        var c = { at: at, dataAt: h.dataAt, size: h.size, end: h.size < 0 ? null : h.dataAt + h.size, tc: null, bodyAt: null, blocks: null };
        var need = (h.size < 0) || !!opts.scan;
        if (!need) {
            var head = await m.r.bytes(h.dataAt, Math.min(64, h.size));
            var th = readIdAt(head, 0), ts = th ? readSizeAt(head, th.len) : null;
            if (th && ts && th.id === ID.TIMECODE && ts.size >= 0) { c.tc = readUint(head, th.len + ts.len, ts.size); c.bodyAt = h.dataAt + th.len + ts.len + ts.size; }
            else need = true;
        }
        if (need) await walkBlocks(m, c, opts.scan ? kfs : null, false);
        out.push(c);
        if (c.end === null) break;
        at = c.end;
        if (opts.until !== undefined && c.tc !== null && c.tc > opts.until) break;
    }
    if (opts.scan) { kfs.sort(function (a, b) { return a.t - b.t; }); m.keyframes = kfs; }
    return out;
}
async function scanAllClusters(m) {
    m.clusters = await walkClusters(m, m.firstClusterAt, { scan: true });
}

// A laced Block carries several frames back to back (Xiph / fixed-size / EBML
// lacing, RFC 9559 §10.3) → [{offset, size}] in FILE bytes, or null when the
// lace header does not add up (the caller then declines the track rather than
// hand a decoder a torn frame). `o` indexes `u8` at the file position `at`,
// `end` is where the Block's payload ends.
function splitLacing(u8, o, at, end, lace) {
    if (o >= u8.length) return null;
    var n = u8[o] + 1, q = o + 1, sizes = [], i, v;
    if (lace === 1) {                                       // Xiph
        for (i = 0; i < n - 1; i++) {
            v = 0; var b;
            do { if (q >= u8.length) return null; b = u8[q++]; v += b; } while (b === 255);
            sizes.push(v);
        }
    } else if (lace === 3) {                                // EBML: first size, then signed deltas
        var f = readSizeAt(u8, q); if (!f || f.size < 0) return null;
        sizes.push(f.size); q += f.len;
        for (i = 1; i < n - 1; i++) {
            var d = readSizeAt(u8, q); if (!d) return null;
            var raw = d.size < 0 ? Math.pow(2, 7 * d.len) - 1 : d.size;
            sizes.push(sizes[i - 1] + raw - (Math.pow(2, 7 * d.len - 1) - 1)); q += d.len;
        }
    } else if (lace === 2) {                                // fixed-size
        var total = end - at - 1;
        if (total % n) return null;
        for (i = 0; i < n - 1; i++) sizes.push(total / n);
    } else return null;
    var hdr = q - o, used = 0;
    for (i = 0; i < sizes.length; i++) { if (!(sizes[i] > 0)) return null; used += sizes[i]; }
    var last = (end - at) - hdr - used;
    if (!(last > 0)) return null;
    sizes.push(last);
    var out = [], pos = at + hdr;
    for (i = 0; i < sizes.length; i++) { out.push({ offset: pos, size: sizes[i] }); pos += sizes[i]; }
    return out;
}

// Read one cluster's block headers. Sets c.tc / c.bodyAt / c.end (for an
// unknown-size cluster the end is where the next top-level element begins)
// and c.blocks = [{at, len, track, abs, key, relAt, dataEnd, lace}] when
// `keepBlocks` (dataEnd — where the Block's payload ends; lace — its lacing bits).
async function walkBlocks(m, c, kfs, keepBlocks) {
    var at = c.dataAt, end = c.end === null ? m.segEnd : c.end, blocks = keepBlocks ? [] : null;
    var buf = null, bufAt = 0;
    async function need(o, n) {
        if (buf && o >= bufAt && o + n <= bufAt + buf.length) return;
        bufAt = o; buf = await m.r.bytes(o, Math.min(SCAN_WINDOW, end - o));
    }
    while (at < end) {
        await need(at, 16);
        var o = at - bufAt;
        var id = readIdAt(buf, o); if (!id) break;
        var sz = readSizeAt(buf, o + id.len); if (!sz) break;
        var dataAt = at + id.len + sz.len;
        if (TOPLEVEL[id.id]) break;                       // an unknown-size cluster ends where the next top-level element begins
        if (sz.size < 0) throw typed('bad-ebml', 'unknown-size cluster child');
        if (id.id === ID.TIMECODE) { await need(dataAt, sz.size); c.tc = readUint(buf, dataAt - bufAt, sz.size); c.bodyAt = dataAt + sz.size; }
        else if (id.id === ID.SIMPLEBLOCK || id.id === ID.BLOCKGROUP) {
            var bAt = dataAt, hasRef = false, bEnd = dataAt + sz.size;
            if (id.id === ID.BLOCKGROUP) {
                await need(dataAt, Math.min(sz.size, 4096));
                var go = dataAt - bufAt, gEnd = go + Math.min(sz.size, 4096), found = null, foundEnd = null, q = go;
                while (q < gEnd) {
                    var gid = readIdAt(buf, q); if (!gid) break;
                    var gsz = readSizeAt(buf, q + gid.len); if (!gsz || gsz.size < 0) break;
                    if (gid.id === ID.BLOCK && found === null) { found = bufAt + q + gid.len + gsz.len; foundEnd = found + gsz.size; }
                    if (gid.id === ID.REFERENCEBLOCK) hasRef = true;
                    q += gid.len + gsz.len + gsz.size;
                }
                if (found === null) { at = dataAt + sz.size; continue; }
                bAt = found; bEnd = foundEnd;
            }
            await need(bAt, 8);
            var bo = bAt - bufAt;
            var tr = readIdAt(buf, bo);                       // track number: a vint with marker bits
            var trackNo = tr.id - Math.pow(2, 7 * tr.len);   // 0x81 → 1
            var rel = readInt16(buf, bo + tr.len), flags = buf[bo + tr.len + 2];
            var key = id.id === ID.SIMPLEBLOCK ? !!(flags & 0x80) : !hasRef;
            if (m.refIsAudio && trackNo === m.videoTrack) key = true;
            var abs = (c.tc || 0) + rel;
            if (kfs && key && trackNo === m.videoTrack) kfs.push({ t: abs, clusterAt: c.at });
            var lace = (flags >> 1) & 3, laced = null;
            if (blocks && lace) {
                var lhAt = bAt + tr.len + 3;                  // after the int16 timecode + flags
                await need(lhAt, Math.min(bEnd - lhAt, 4096));
                laced = splitLacing(buf, lhAt - bufAt, lhAt, bEnd, lace);
            }
            if (blocks) blocks.push({ at: at, len: id.len + sz.len + sz.size, track: trackNo, abs: abs, key: key, relAt: bAt + tr.len, dataEnd: bEnd, lace: lace, frames: laced });
        }
        at = dataAt + sz.size;
    }
    if (c.end === null) c.end = at;
    if (blocks) c.blocks = blocks;
    return c;
}

/* ── plan ───────────────────────────────────────────────────────────────── */
function ticksOf(m, sec) { return Math.round(sec * 1e9 / m.timecodeScale); }
function secOf(m, ticks) { return ticks * m.timecodeScale / 1e9; }

async function plan(m, startSec, endSec) {
    var startT = ticksOf(m, Math.max(0, startSec)), endT = ticksOf(m, endSec);
    if (!(endT > startT)) throw typed('empty-range', 'end must be after start');
    // the last keyframe ≤ start (or the first one)
    var kf = m.keyframes[0], i;
    for (i = 0; i < m.keyframes.length; i++) { if (m.keyframes[i].t <= startT) kf = m.keyframes[i]; else break; }
    if (kf.t > endT) throw typed('no-samples-in-range', 'no keyframe before the end of the range');
    // a cue-derived keyframe is a promise about a cluster; the cluster's own blocks are the fact
    if (m.hasCues) {
        var kc = { at: kf.clusterAt, dataAt: null, size: null, end: null, tc: null, bodyAt: null, blocks: null };
        var kh = await header(m.r, kf.clusterAt);
        if (!kh || kh.id !== ID.CLUSTER) throw typed('bad-ebml', 'cue points outside a cluster');
        kc.dataAt = kh.dataAt; kc.size = kh.size; kc.end = kh.size < 0 ? null : kh.dataAt + kh.size;
        await walkBlocks(m, kc, null, true);
        var best = null;
        for (i = 0; i < kc.blocks.length; i++) { var bk = kc.blocks[i]; if (bk.track === m.videoTrack && bk.key && bk.abs <= startT && (best === null || bk.abs > best)) best = bk.abs; }
        if (best === null) for (i = 0; i < kc.blocks.length; i++) { var bk2 = kc.blocks[i]; if (bk2.track === m.videoTrack && bk2.key && (best === null || bk2.abs < best)) best = bk2.abs; }
        if (best === null) throw typed('no-keyframes', 'the cued cluster holds no video keyframe');
        kf = { t: best, clusterAt: kf.clusterAt, blocks: kc.blocks, cluster: kc };
    }
    var base = kf.t;
    // clusters from the keyframe's cluster to the one holding endT
    var cl;
    if (m.clusters) {
        var idx = -1; for (i = 0; i < m.clusters.length; i++) if (m.clusters[i].at === kf.clusterAt) { idx = i; break; }
        if (idx < 0) throw typed('bad-ebml', 'keyframe cluster is not in the cluster list');
        cl = m.clusters.slice(idx);
    } else { cl = await walkClusters(m, kf.clusterAt, { until: endT }); if (kf.blocks && cl.length && cl[0].at === kf.clusterAt) { cl[0].blocks = kf.blocks; cl[0].tc = kf.cluster.tc; cl[0].bodyAt = kf.cluster.bodyAt; } }
    var keep = [];
    for (i = 0; i < cl.length; i++) { if (cl[i].tc !== null && cl[i].tc > endT) break; keep.push(cl[i]); }
    if (!keep.length) throw typed('no-samples-in-range', 'no cluster in range');

    var parts = [], outClusters = [], pos = 0, lastAbs = base, videoFrames = 0, audioFrames = 0, lastVideoAbs = base;
    for (i = 0; i < keep.length; i++) {
        var c = keep[i], first = (i === 0), last = (i === keep.length - 1);
        var newTc = Math.max(0, c.tc - base);
        var canCopy = !first && !last && c.bodyAt !== null && c.tc - base >= 0 && c.end !== null;
        if (canCopy) {
            var bodyLen = c.end - c.bodyAt;
            var tcEl = new Uint8Array(elUint(ID.TIMECODE, newTc));
            var hdr = concatBytes([new Uint8Array(encId(ID.CLUSTER)), new Uint8Array(encSize8(bodyLen + tcEl.length)), tcEl]);
            outClusters.push({ at: pos, tc: newTc, keyTimes: null });
            parts.push(hdr); pos += hdr.length;
            parts.push({ at: c.bodyAt, len: bodyLen }); pos += bodyLen;
            continue;
        }
        if (!c.blocks) await walkBlocks(m, c, null, true);
        var body = [], keyTimes = [];
        for (var b = 0; b < c.blocks.length; b++) {
            var blk = c.blocks[b];
            if (blk.abs < base || blk.abs > endT) continue;
            var bytes = new Uint8Array(await m.r.bytes(blk.at, blk.len));   // a copy: the two edge clusters are small
            var relNew = blk.abs - base - newTc;
            if (relNew < -32768 || relNew > 32767) throw typed('bad-ebml', 'block timecode out of int16 after re-basing');
            var ro = blk.relAt - blk.at;
            bytes[ro] = (relNew >> 8) & 0xFF; bytes[ro + 1] = relNew & 0xFF;
            body.push(bytes);
            if (blk.track === m.videoTrack) { videoFrames++; if (blk.key) keyTimes.push(blk.abs - base); if (blk.abs > lastVideoAbs) lastVideoAbs = blk.abs; } else audioFrames++;
            if (blk.abs > lastAbs) lastAbs = blk.abs;
        }
        if (!body.length) continue;
        var bodyBytes = concatBytes(body);
        var tcEl2 = new Uint8Array(elUint(ID.TIMECODE, newTc));
        var hdr2 = concatBytes([new Uint8Array(encId(ID.CLUSTER)), new Uint8Array(encSize8(bodyBytes.length + tcEl2.length)), tcEl2]);
        outClusters.push({ at: pos, tc: newTc, keyTimes: keyTimes });
        parts.push(hdr2); pos += hdr2.length;
        parts.push(bodyBytes); pos += bodyBytes.length;
    }
    if (!outClusters.length) throw typed('no-samples-in-range', 'nothing to keep');
    // duration: the last kept block plus one frame of the source's cadence, bounded by the request
    var frameT = 33;
    if (m.keyframes.length > 1) frameT = Math.max(1, Math.round((m.keyframes[m.keyframes.length - 1].t - m.keyframes[0].t) / Math.max(1, (m.keyframes.length - 1) * 30)));
    var durT = Math.max(1, Math.min(endT, lastAbs + frameT) - base);
    var kfTimes = [];
    for (i = 0; i < m.keyframes.length; i++) { var t = m.keyframes[i].t; if (t >= base && t <= endT) kfTimes.push(t - base); }
    return { base: base, endT: endT, durT: durT, parts: parts, clusters: outClusters, clusterBytes: pos, videoFrames: videoFrames, audioFrames: audioFrames, kfTimes: kfTimes };
}

function buildHead(m, p) {
    var i, j;
    var info = [].concat(elUint(ID.TIMECODESCALE, m.timecodeScale), elFloat(ID.DURATION, p.durT));
    for (i = 0; i < m.apps.length; i++) info = info.concat(el(m.apps[i].id, m.apps[i].bytes));
    var infoEl = el(ID.INFO, info);
    // keyframes → output clusters: rebuilt clusters know their own keyframes; copied clusters take the source cue list
    var keyList = [], seen = {};
    for (i = 0; i < p.clusters.length; i++) {
        var c = p.clusters[i];
        if (c.keyTimes) for (j = 0; j < c.keyTimes.length; j++) { keyList.push({ t: c.keyTimes[j], clusterIdx: i }); seen[c.keyTimes[j]] = true; }
    }
    for (i = 0; i < p.kfTimes.length; i++) {
        var t = p.kfTimes[i]; if (seen[t]) continue;
        var idx = -1; for (j = 0; j < p.clusters.length; j++) if (p.clusters[j].tc <= t) idx = j;
        if (idx >= 0 && p.clusters[idx].keyTimes === null) keyList.push({ t: t, clusterIdx: idx });
    }
    keyList.sort(function (a, b) { return a.t - b.t; });
    /* An audio track is all sync points, and a cue for each would be an index
       as heavy as the sound it indexes: 69 bytes per 20-ms Opus block is
       28 kbit/s of cues on a 64 kbit/s take (measured on a Firefox recording,
       8 s: 68.9 KB in, 96.8 KB out). A player seeks to the cue at or before the
       target and reads on from there, so one cue a second is all it needs. */
    if (m.refIsAudio) {
        var cueStep = ticksOf(m, 1), thin = [], lastCueT = -Infinity;
        for (i = 0; i < keyList.length; i++) if (keyList[i].t - lastCueT >= cueStep) { thin.push(keyList[i]); lastCueT = keyList[i].t; }
        keyList = thin;
    }
    var CUEPOINT_LEN = 1 + 8 + (1 + 8 + 8) + (1 + 8 + (1 + 8 + 8) + (1 + 8 + 8));
    var cuesLen = 4 + 8 + keyList.length * CUEPOINT_LEN;
    var headLen = infoEl.length + m.tracksBytes.length + cuesLen;
    var cuesBody = [];
    for (i = 0; i < keyList.length; i++) {
        var clusterPos = headLen + p.clusters[keyList[i].clusterIdx].at;   // relative to the segment data start
        cuesBody = cuesBody.concat(el(ID.CUEPOINT, [].concat(elUint(ID.CUETIME, keyList[i].t), el(ID.CUETRACKPOSITIONS, [].concat(elUint(ID.CUETRACK, m.videoTrack), elUint(ID.CUECLUSTERPOSITION, clusterPos))))));
    }
    var cuesEl = el(ID.CUES, cuesBody);
    if (cuesEl.length !== cuesLen) throw typed('bad-ebml', 'cues size mismatch ' + cuesEl.length + ' vs ' + cuesLen);
    var segHdr = encId(ID.SEGMENT).concat(encSize8(headLen + p.clusterBytes));
    return { bytes: concatBytes([m.ebml, new Uint8Array(segHdr), new Uint8Array(infoEl), m.tracksBytes, new Uint8Array(cuesEl)]), cues: keyList.length };
}

/* ── API ────────────────────────────────────────────────────────────────── */
async function run(file, startSec, endSec) {
    if (!file || !file.size) throw typed('not-webm', 'empty input');
    var m = await readModel(file);
    var p = await plan(m, startSec, endSec);
    var head = buildHead(m, p);
    var parts = [head.bytes];
    for (var i = 0; i < p.parts.length; i++) {
        var q = p.parts[i];
        parts.push(q instanceof Uint8Array ? q : file.slice(q.at, q.at + q.len));
    }
    var newName = (file.name || 'video.webm').replace(/(\.[^.]+)?$/, '_trim.webm');
    var out = new File(parts, newName, { type: 'video/webm', lastModified: Date.now() });
    out.trimInfo = { container: 'webm', startMs: Math.round(secOf(m, p.base) * 1000), endMs: Math.round(secOf(m, p.endT) * 1000), durationMs: Math.round(secOf(m, p.durT) * 1000),
                     parts: parts.length, size: out.size, tracks: m.tracks.length, videoFrames: p.videoFrames, audioFrames: p.audioFrames, cues: head.cues, srcCues: m.hasCues,
                     reads: m.r.reads, readBytes: m.r.readBytes };
    return out;
}
async function keyframeTimes(file) {
    var m = await readModel(file);
    return m.keyframes.map(function (k) { return secOf(m, k.t); });
}
async function inspect(file) {
    var m = await readModel(file);
    return { durationMs: m.durationTicks !== null ? Math.round(secOf(m, m.durationTicks) * 1000) : null, timecodeScale: m.timecodeScale,
             tracks: m.tracks, videoTrack: m.videoTrack, keyframes: m.keyframes.length, cues: m.hasCues, segmentSized: m.segSized,
             clusters: m.clusters ? m.clusters.length : null, reads: m.r.reads, readBytes: m.r.readBytes };
}

/* The tracks as SAMPLE TABLES — every frame's {key, ts, dur, offset, size} in
   µs and file bytes, the frames themselves left in the file. It is the shape
   the lazy mp4 demux hands a WebCodecs decoder, so a Matroska file rides the
   same decode lanes: VideoMergeWebCodecs.demuxMatroskaLazy (video only;
   /audio-to-video's looping background, 2026-09-24) and WebCodecsPipeline's
   demuxMatroska (video + audio; /video-speed and every pipeline tool,
   2026-09-25 — a 16-min WebM from a CCTV export went to single-thread x264
   and ran for hours). Only block HEADERS are read — one sequential pass over
   the clusters in 8 MB windows, whatever the file size.
   Laced video is declined: one frame per block is how video is muxed, and a
   wrong split is a broken frame, not a slightly late one. Laced AUDIO is split
   (mkvmerge laces audio by default); each frame after the first is timed by
   the track's DefaultDuration or, failing that, by the codec's fixed frame
   size — and a lace nobody can time declines the audio track (audio.why). */
var FIXED_FRAME = { 'A_AAC': 1024, 'A_MPEG/L3': 1152, 'A_MPEG/L2': 1152, 'A_AC3': 1536, 'A_EAC3': 1536 };
function laceFrameUs(t, firstByte) {
    if (t.defaultDurationNs > 0) return t.defaultDurationNs / 1000;
    var sr = t.outSampleRate || t.sampleRate;
    var fam = /^A_AAC/.test(t.codec) ? 'A_AAC' : t.codec;
    if (FIXED_FRAME[fam] && sr > 0) return FIXED_FRAME[fam] * 1e6 / sr;
    // Opus, one frame per packet (TOC code 0): the frame size is in the TOC
    // (RFC 6716 §3.1). Multi-frame packets are left untimed.
    if (t.codec === 'A_OPUS' && firstByte != null && (firstByte & 3) === 0) {
        var cfg = firstByte >> 3;
        if (cfg < 12) return [10000, 20000, 40000, 60000][cfg & 3];
        if (cfg < 16) return [10000, 20000][cfg & 1];
        return [2500, 5000, 10000, 20000][cfg & 3];
    }
    return 0;
}
// Durations in PRESENTATION order (an H.264 track in Matroska stores decode
// order); a sample that already carries one (a timed lace) keeps it.
function fillDurations(list, fallbackUs) {
    var order = list.slice().sort(function (a, b) { return a.ts - b.ts; }), gaps = [], i;
    for (i = 0; i + 1 < order.length; i++) {
        if (!(order[i].dur > 0)) order[i].dur = order[i + 1].ts - order[i].ts;
        if (order[i].dur > 0) gaps.push(order[i].dur);
    }
    gaps.sort(function (a, b) { return a - b; });
    var last = order[order.length - 1];
    if (!(last.dur > 0)) last.dur = gaps.length ? gaps[gaps.length >> 1] : fallbackUs;
}
async function trackTables(file, opts) {
    opts = opts || {};
    if (!file || !file.size) throw typed('not-webm', 'empty input');
    var m = await readModel(file);
    var vt = null, at = null, i, j, k;
    for (i = 0; i < m.tracks.length; i++) if (m.tracks[i].number === m.videoTrack) vt = m.tracks[i];
    if (!vt || vt.type !== 1) throw typed('no-video-track', 'no video track');
    if (vt.encoded) throw typed('encoded-track', 'the video track is compressed or encrypted by the container');
    if (opts.audio) {
        var auds = m.tracks.filter(function (t) { return t.type === 2; });
        at = auds[+opts.audioTrackIndex || 0] || auds[0] || null;
    }
    var audio = at ? { track: at, samples: [], why: at.encoded ? 'encoded-track' : '' } : null;
    var clusters = m.clusters || await walkClusters(m, m.firstClusterAt, {});
    var out = [], n = 0;
    for (i = 0; i < clusters.length; i++) {
        var c = clusters[i];
        if (!c.blocks) await walkBlocks(m, c, null, true);
        for (j = 0; j < c.blocks.length; j++) {
            var b = c.blocks[j];
            var tsUs = Math.round(b.abs * m.timecodeScale / 1000);
            if (b.track === m.videoTrack) {
                if (b.lace) throw typed('laced-video', 'laced video blocks');
                var vAt = b.relAt + 3;                        // int16 timecode + flags byte
                if (!(b.dataEnd > vAt)) continue;
                out.push({ key: b.key, ts: tsUs, dur: 0, offset: vAt, size: b.dataEnd - vAt });
            } else if (audio && !audio.why && b.track === at.number) {
                if (!b.lace) {
                    var aAt = b.relAt + 3;
                    if (b.dataEnd > aAt) audio.samples.push({ key: true, ts: tsUs, dur: 0, offset: aAt, size: b.dataEnd - aAt });
                } else if (!b.frames) {
                    audio.why = 'bad-lacing';
                } else {
                    var first = (at.codec === 'A_OPUS' && !(at.defaultDurationNs > 0)) ? (await m.r.bytes(b.frames[0].offset, 1))[0] : null;
                    var fUs = laceFrameUs(at, first);
                    if (!(fUs > 0)) { audio.why = 'laced-untimed'; continue; }
                    for (k = 0; k < b.frames.length; k++) {
                        audio.samples.push({ key: true, ts: Math.round(tsUs + k * fUs), dur: Math.round(fUs), offset: b.frames[k].offset, size: b.frames[k].size });
                    }
                }
            }
        }
        c.blocks = null;                                      // the table is what we keep, not the block list
        if (opts.onAlive && (++n % 64) === 0) { try { opts.onAlive(); } catch (_) {} }
    }
    if (!out.length) throw typed('no-samples-in-range', 'no video frames');
    fillDurations(out, Math.round(1e6 / 30));
    if (audio && !audio.why) {
        if (audio.samples.length) fillDurations(audio.samples, 0);
        else audio.why = 'no-audio-frames';
    }
    return {
        video: { track: vt, codecId: vt.codec, codecPrivate: vt.codecPrivate, width: vt.width, height: vt.height, samples: out },
        audio: audio,
        timecodeScale: m.timecodeScale,
        durationUs: m.durationTicks !== null ? Math.round(m.durationTicks * m.timecodeScale / 1000) : 0,
        reads: m.r.reads, readBytes: m.r.readBytes
    };
}
async function videoSamples(file) {
    var t = await trackTables(file, { audio: false });
    return { codecId: t.video.codecId, codecPrivate: t.video.codecPrivate, width: t.video.width, height: t.video.height,
             samples: t.video.samples, timecodeScale: t.timecodeScale, reads: t.reads, readBytes: t.readBytes };
}

window.WebmCopyTrim = { run: run, keyframeTimes: keyframeTimes, inspect: inspect, isWebm: isWebm, videoSamples: videoSamples, trackTables: trackTables };
})();
