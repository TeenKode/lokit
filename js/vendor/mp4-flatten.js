/**
 * Mp4Flatten — the flat-MP4 sample-table model, and the two plans built on it:
 *
 *   plan(readAt, size)          fragmented MP4 (ftyp · moov+mvex · [moof mdat]… · mfra)
 *                               → flat MP4 (ftyp · free · [free mdat]… · moov) IN PLACE,
 *                               without copying a single sample byte;
 *   readFlat(moovBytes)         a flat moov's sample tables → the same track model;
 *   cutPlan(init, start, end)   a lossless cut of a flat MP4 → a NEW flat file
 *                               (ftyp · moov · mdat, moov first) described as byte
 *                               ranges of the source: the caller assembles it from
 *                               slices, so nothing is copied and nothing is decoded.
 *   concatPlan(clips, opts)     a lossless JOIN of several flat MP4s → one new flat
 *                               file, described the same way: byte ranges of the
 *                               sources plus the few bytes the join itself needs
 *                               (a moov, parameter sets, AAC silence). See the
 *                               section «the concat plan» for what it guarantees.
 *
 * Why one module. The screen recorder writes its take as fMP4 straight into OPFS
 * through a sync access handle, so a crash, a reload or a closed tab leaves every
 * finished fragment on disk; at finalize the file is flattened here, and the very
 * same routine recovers an interrupted take. The inline trim of that recording,
 * and the pre-trim modal every video tool offers, cut the flat file with the same
 * tables — one reader, one moov writer, one definition of a sample. Before
 * 2026-09-17 the cut lived in a second implementation on top of mp4box.js that
 * streamed the whole file through a demuxer and re-muxed sample by sample; on a
 * moov-at-end file (every recording, every ffmpeg output without +faststart) it
 * followed the demuxer's skip-ahead hints, left holes in the data it fed and
 * delivered 3–6 s of a 55 s cut as «done» — 74 % of trims on prod, silently.
 *
 * How (flatten). Sample tables (stts/ctts/stss/stsz/stsc/co64) are rebuilt from
 * the moof/traf/trun boxes; the sample bytes stay where they are inside the mdat
 * boxes and are referenced by absolute offsets. The old moov (whose mvex would
 * make players look for fragments) and every moof become `free` boxes — a 4-byte
 * type rename each. Anything after the last COMPLETE fragment (a truncated
 * fragment, mfra) is cut off and the new moov is appended there.
 *
 * How (cut). The window is chosen in PRESENTATION time, per track: video starts
 * on the last sync sample at or before the requested start (a copy cut can only
 * begin on a keyframe), every other track on the first sample still playing at
 * that instant; each track gets an edit list that places its first presented
 * sample exactly where the source presented it, so audio/video alignment (AAC
 * priming edits, B-frame composition offsets, a track that starts late) survives
 * byte for byte. The window's samples go out in the source's own order (its
 * interleave, kept exactly), moov comes first (players and messengers can start
 * before the download ends), offsets are 64-bit, and the plan carries the source
 * byte ranges in output order — one to a handful of them for a take.
 *
 * Pure: no DOM, no I/O. `readAt(offset, length) → Promise<Uint8Array>` is supplied
 * by the caller (a sync access handle in the worker, a File on the main thread, a
 * Buffer in Node). Loaded in a Worker, in a page or in Node.
 */
(function (root) {
    'use strict';

    var MAX_TOP_LEVEL_BOXES = 2000000;   // sanity: a 24 h take at 1 s fragments is ~170k

    function str4(u8, o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
    function u32(u8, o) { return ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]; }
    function i32(u8, o) { return (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]; }
    function u64(u8, o) { return u32(u8, o) * 4294967296 + u32(u8, o + 4); }
    function i64(u8, o) { var hi = i32(u8, o); return hi * 4294967296 + u32(u8, o + 4); }

    // ── writer ──────────────────────────────────────────────────────────────
    function Writer() { this.buf = new Uint8Array(65536); this.pos = 0; }
    Writer.prototype.ensure = function (n) {
        if (this.pos + n <= this.buf.length) return;
        var nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
        nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
    };
    Writer.prototype.u8 = function (v) { this.ensure(1); this.buf[this.pos++] = v & 255; };
    Writer.prototype.u16 = function (v) { this.ensure(2); this.buf[this.pos++] = (v >>> 8) & 255; this.buf[this.pos++] = v & 255; };
    Writer.prototype.u32 = function (v) { this.ensure(4); this.buf[this.pos++] = (v >>> 24) & 255; this.buf[this.pos++] = (v >>> 16) & 255; this.buf[this.pos++] = (v >>> 8) & 255; this.buf[this.pos++] = v & 255; };
    Writer.prototype.i32 = function (v) { this.u32(v >>> 0); };
    Writer.prototype.u64 = function (v) { this.u32(Math.floor(v / 4294967296)); this.u32(v >>> 0); };
    Writer.prototype.i64 = function (v) { if (v >= 0) return this.u64(v); var hi = Math.floor(v / 4294967296); this.u32(hi >>> 0); this.u32((v - hi * 4294967296) >>> 0); };
    Writer.prototype.bytes = function (u8) { this.ensure(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; };
    Writer.prototype.ascii = function (s) { for (var i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); };
    // box(type, fn) — writes the header, runs fn to write the payload, patches the size
    Writer.prototype.box = function (type, fn) {
        var start = this.pos; this.u32(0); this.ascii(type); fn.call(this);
        var size = this.pos - start; var p = this.pos; this.pos = start; this.u32(size); this.pos = p;
    };
    Writer.prototype.fullbox = function (type, version, flags, fn) {
        this.box(type, function () { this.u8(version); this.u8((flags >>> 16) & 255); this.u8((flags >>> 8) & 255); this.u8(flags & 255); fn.call(this); });
    };
    Writer.prototype.result = function () { return this.buf.slice(0, this.pos); };

    // ── in-memory box tree (for a moov only — it is small) ──────────────────
    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 1, mvex: 1, dinf: 1, udta: 1 };
    function parseChildren(u8, start, end) {
        var out = [], o = start;
        while (o + 8 <= end) {
            var size = u32(u8, o), type = str4(u8, o + 4), hdr = 8;
            if (size === 1) { size = u64(u8, o + 8); hdr = 16; }
            else if (size === 0) size = end - o;
            if (size < hdr || o + size > end) break;
            var b = { type: type, start: o, size: size, hdr: hdr };
            if (CONTAINERS[type]) b.children = parseChildren(u8, o + hdr, o + size);
            out.push(b); o += size;
        }
        return out;
    }
    function child(box, type) { if (!box || !box.children) return null; for (var i = 0; i < box.children.length; i++) if (box.children[i].type === type) return box.children[i]; return null; }
    function children(box, type) { var r = []; if (!box || !box.children) return r; for (var i = 0; i < box.children.length; i++) if (box.children[i].type === type) r.push(box.children[i]); return r; }

    // ── the moov: what we need from it (init moov of an fMP4, or a flat moov) ──
    function parseInit(moovBytes) {
        var tree = parseChildren(moovBytes, 0, moovBytes.length);
        var moov = tree[0]; if (!moov || moov.type !== 'moov') throw new Error('init: no moov');
        var mvhd = child(moov, 'mvhd'); if (!mvhd) throw new Error('init: no mvhd');
        var mv = mvhd.start + mvhd.hdr, mvVer = moovBytes[mv];
        var movieTs = mvVer === 1 ? u32(moovBytes, mv + 4 + 16) : u32(moovBytes, mv + 4 + 8);
        var mvex = child(moov, 'mvex');
        var trexById = {};
        children(mvex, 'trex').forEach(function (t) {
            var p = t.start + t.hdr + 4;   // fullbox
            trexById[u32(moovBytes, p)] = { descIdx: u32(moovBytes, p + 4), dur: u32(moovBytes, p + 8), size: u32(moovBytes, p + 12), flags: u32(moovBytes, p + 16) };
        });
        var tracks = children(moov, 'trak').map(function (trak) {
            var tkhd = child(trak, 'tkhd'), mdia = child(trak, 'mdia'), mdhd = child(mdia, 'mdhd'), hdlr = child(mdia, 'hdlr'), minf = child(mdia, 'minf'), stbl = child(minf, 'stbl'), stsd = child(stbl, 'stsd');
            if (!tkhd || !mdia || !mdhd || !minf || !stbl || !stsd) throw new Error('init: incomplete trak');
            var tp = tkhd.start + tkhd.hdr, tkVer = moovBytes[tp];
            var trackId = tkVer === 1 ? u32(moovBytes, tp + 4 + 16) : u32(moovBytes, tp + 4 + 8);
            var mp = mdhd.start + mdhd.hdr, mdVer = moovBytes[mp];
            var mediaTs = mdVer === 1 ? u32(moovBytes, mp + 4 + 16) : u32(moovBytes, mp + 4 + 8);
            var handler = hdlr ? str4(moovBytes, hdlr.start + hdlr.hdr + 4 + 4) : '';
            return { trak: trak, tkhd: tkhd, mdia: mdia, mdhd: mdhd, minf: minf, stbl: stbl, id: trackId, mediaTs: mediaTs, handler: handler, trex: trexById[trackId] || null,
                     samples: { n: 0, dur: [], size: [], sync: [], cts: [], anyCts: false, anyNonSync: false }, chunks: [] /* {offset, count, descIdx} */, edits: null };
        });
        return { bytes: moovBytes, moov: moov, movieTs: movieTs, mvhd: mvhd, mvVer: mvVer, tracks: tracks };
    }

    // ── moof: feed samples into the tracks ──────────────────────────────────
    // Returns the byte range [dataStart, dataEnd) the fragment's samples occupy.
    function parseMoof(u8, moofFileOffset, init) {
        var moof = parseChildren(u8, 0, u8.length)[0];
        if (!moof || moof.type !== 'moof') throw new Error('moof: bad box');
        // traf is not in CONTAINERS (we parse it by hand below), moof is not either
        var o = moof.hdr, end = moof.size, dataMin = Infinity, dataMax = 0;
        var byId = {}; init.tracks.forEach(function (t) { byId[t.id] = t; });
        while (o + 8 <= end) {
            var size = u32(u8, o), type = str4(u8, o + 4), hdr = 8;
            if (size === 1) { size = u64(u8, o + 8); hdr = 16; }
            if (size < hdr || o + size > end) throw new Error('moof: bad child');
            if (type === 'traf') {
                var to = o + hdr, tend = o + size, tfhd = null, tfdt = 0, truns = [];
                while (to + 8 <= tend) {
                    var s2 = u32(u8, to), t2 = str4(u8, to + 4), h2 = 8;
                    if (s2 === 1) { s2 = u64(u8, to + 8); h2 = 16; }
                    if (s2 < h2 || to + s2 > tend) throw new Error('traf: bad child');
                    var p = to + h2, ver = u8[p], flags = u32(u8, p) & 0xffffff; p += 4;
                    if (t2 === 'tfhd') {
                        tfhd = { flags: flags, trackId: u32(u8, p) }; p += 4;
                        if (flags & 0x1) { tfhd.baseDataOffset = u64(u8, p); p += 8; }
                        if (flags & 0x2) { tfhd.descIdx = u32(u8, p); p += 4; }
                        if (flags & 0x8) { tfhd.defDur = u32(u8, p); p += 4; }
                        if (flags & 0x10) { tfhd.defSize = u32(u8, p); p += 4; }
                        if (flags & 0x20) { tfhd.defFlags = u32(u8, p); p += 4; }
                    } else if (t2 === 'tfdt') {
                        tfdt = ver === 1 ? u64(u8, p) : u32(u8, p);
                    } else if (t2 === 'trun') {
                        var count = u32(u8, p); p += 4;
                        var run = { ver: ver, flags: flags, count: count, dataOffset: null, firstFlags: null, entries: p };
                        if (flags & 0x1) { run.dataOffset = i32(u8, p); p += 4; }
                        if (flags & 0x4) { run.firstFlags = u32(u8, p); p += 4; }
                        run.entries = p;
                        truns.push(run);
                    }
                    to += s2;
                }
                if (!tfhd) throw new Error('traf: no tfhd');
                var track = byId[tfhd.trackId]; if (!track) throw new Error('traf: unknown track ' + tfhd.trackId);
                var trex = track.trex || {};
                var defDur = tfhd.defDur != null ? tfhd.defDur : trex.dur, defSize = tfhd.defSize != null ? tfhd.defSize : trex.size, defFlags = tfhd.defFlags != null ? tfhd.defFlags : trex.flags;
                var descIdx = tfhd.descIdx != null ? tfhd.descIdx : (trex.descIdx || 1);
                // base data offset: explicit, else moof start (default-base-is-moof, and also the
                // ISO default for the first run; later runs continue where the previous ended)
                var base = (tfhd.flags & 0x1) ? tfhd.baseDataOffset : moofFileOffset;
                var cursor = base;
                for (var r = 0; r < truns.length; r++) {
                    var run2 = truns[r], q = run2.entries;
                    var dataStart = run2.dataOffset != null ? base + run2.dataOffset : cursor;
                    var S = track.samples, runBytes = 0;
                    for (var i = 0; i < run2.count; i++) {
                        var dur = defDur, sz = defSize, fl = (i === 0 && run2.firstFlags != null) ? run2.firstFlags : defFlags, cts = 0;
                        if (run2.flags & 0x100) { dur = u32(u8, q); q += 4; }
                        if (run2.flags & 0x200) { sz = u32(u8, q); q += 4; }
                        if (run2.flags & 0x400) { fl = u32(u8, q); q += 4; }
                        if (run2.flags & 0x800) { cts = i32(u8, q); q += 4; }   // signed in both versions — see the ctts reader in readFlat
                        if (dur == null || sz == null) throw new Error('trun: sample without duration/size and no defaults');
                        if (fl == null) fl = 0;
                        S.dur.push(dur); S.size.push(sz); S.cts.push(cts);
                        var nonSync = !!(fl & 0x10000);
                        S.sync.push(!nonSync);
                        if (nonSync) S.anyNonSync = true;
                        if (cts !== 0) S.anyCts = true;
                        S.n++; runBytes += sz;
                    }
                    if (run2.count > 0) track.chunks.push({ offset: dataStart, count: run2.count, descIdx: descIdx, decodeTime: tfdt });
                    if (dataStart < dataMin) dataMin = dataStart;
                    if (dataStart + runBytes > dataMax) dataMax = dataStart + runBytes;
                    cursor = dataStart + runBytes;
                }
            }
            o += size;
        }
        return { dataMin: dataMin, dataMax: dataMax };
    }

    // ── flat moov: read the sample tables into the same model parseMoof fills ──
    /**
     * readFlat(moovBytes) → init — the tracks carry samples (dur/size/sync/cts),
     * chunks ({offset, count, descIdx}, absolute file offsets) and edits (the
     * elst entries, or null). Throws on a moov whose sample tables are missing
     * or inconsistent, so a caller never cuts a file it misread.
     */
    /* ── a «unit» track: every sample the same size and the same duration ──
       Uncompressed audio in a camera file (Sony XAVC S, Panasonic, iPhone ProRes:
       QuickTime PCM — twos/sowt/lpcm/in24…) is stored one sample per PCM FRAME:
       48 000 samples a second, 102 million in a 35-minute take, described by a
       moov of 0.9 MB (one stts run, a constant stsz, stsc runs). Read sample by
       sample that is four arrays of 102 M entries — 8.9–13.8 s and gigabytes in
       WebKit for EVERY part of a split, plus two 816 MB Float64Arrays in each cut
       (support chat 728, /video-trim «Разделить», desktop Safari: nine parts of a
       5.5 GB take). Such a track is kept as one macro-sample per CHUNK (the
       chunk's samples are contiguous bytes), `t.unit` says how to count inside
       one, and the cut picks its window sample by sample on the same arithmetic
       (see cutPlan) — the output is byte for byte what the per-sample model wrote. */
    var UNIT_MIN = 65536;
    function unitShape(B, t, stts, ctts, stss, stsz) {
        if (t.handler !== 'soun' || !stsz || stss) return null;
        var p = stsz.start + stsz.hdr + 4, size = u32(B, p), count = u32(B, p + 4);
        if (!size || count < UNIT_MIN) return null;
        p = stts.start + stts.hdr + 4;
        var n = u32(B, p), dur = -1, total = 0; p += 4;
        for (var i = 0; i < n; i++) { var c = u32(B, p), d = u32(B, p + 4); p += 8; if (!c) continue; if (dur < 0) dur = d; else if (d !== dur) return null; total += c; }
        if (dur <= 0 || total !== count) return null;
        if (ctts) {
            p = ctts.start + ctts.hdr + 4; n = u32(B, p); p += 4;
            for (var j = 0; j < n; j++) { if (u32(B, p + 4) !== 0) return null; p += 8; }
        }
        return { dur: dur, size: size, frames: count };
    }
    function readFlat(moovBytes) {
        var init = parseInit(moovBytes), B = moovBytes;
        init.tracks.forEach(function (t) {
            var stbl = t.stbl, S = t.samples;
            var stts = child(stbl, 'stts'), ctts = child(stbl, 'ctts'), stss = child(stbl, 'stss'), stsz = child(stbl, 'stsz'), stz2 = child(stbl, 'stz2'), stsc = child(stbl, 'stsc'), stco = child(stbl, 'stco'), co64 = child(stbl, 'co64');
            if (!stts || !(stsz || stz2) || !stsc || !(stco || co64)) throw new Error('flat: incomplete stbl for track ' + t.id);
            var p, n, i, k;
            var unit = unitShape(B, t, stts, ctts, stss, stsz);
            if (unit) { readUnitChunks(B, t, unit, stsc, stco, co64); readEdits(B, t); return; }
            // stts — decode deltas
            p = stts.start + stts.hdr + 4; n = u32(B, p); p += 4;
            for (i = 0; i < n; i++) { var c = u32(B, p), d = u32(B, p + 4); p += 8; for (k = 0; k < c; k++) S.dur.push(d); }
            S.n = S.dur.length;
            // stsz / stz2 — sizes
            if (stsz) {
                p = stsz.start + stsz.hdr + 4; var ss = u32(B, p), sc = u32(B, p + 4); p += 8;
                if (sc !== S.n) throw new Error('flat: stsz count ' + sc + ' ≠ stts ' + S.n + ' for track ' + t.id);
                if (ss) for (i = 0; i < sc; i++) S.size.push(ss); else for (i = 0; i < sc; i++) { S.size.push(u32(B, p)); p += 4; }
            } else {
                p = stz2.start + stz2.hdr + 4; var fs = B[p + 3], zc = u32(B, p + 4); p += 8;
                if (zc !== S.n) throw new Error('flat: stz2 count ' + zc + ' ≠ stts ' + S.n + ' for track ' + t.id);
                for (i = 0; i < zc; i++) {
                    if (fs === 16) { S.size.push((B[p] << 8) | B[p + 1]); p += 2; }
                    else if (fs === 8) { S.size.push(B[p]); p += 1; }
                    else { S.size.push((i & 1) ? (B[p] & 15) : (B[p] >> 4)); if (i & 1) p += 1; }
                }
            }
            // ctts — composition offsets, SIGNED in both versions. The standard calls a
            // version 0 value unsigned, but writers put negative offsets there (mp4-muxer
            // did until 04.11.2026 — every export of ours at 24/30/60 fps: −1…−10 ticks
            // of rounding drift), and every reader that plays such a file takes them as
            // signed: FFmpeg, Chromium, Media Foundation, mp4box.js. Read unsigned, −1
            // was 4 294 967 295 ticks — frame 14 onward ten hours away, and «keep 0–9 s»
            // of a 10 s clip kept 14 frames under 9 s of sound (Nikolai, 04.11.2026). A
            // genuine v0 offset ≥ 2³¹ ticks (hours) does not exist.
            if (ctts) {
                p = ctts.start + ctts.hdr + 4; n = u32(B, p); p += 4;
                for (i = 0; i < n; i++) { var cc = u32(B, p), co = i32(B, p + 4); p += 8; for (k = 0; k < cc; k++) S.cts.push(co); if (co !== 0) S.anyCts = true; }
                if (S.cts.length !== S.n) throw new Error('flat: ctts count ' + S.cts.length + ' ≠ ' + S.n + ' for track ' + t.id);
            } else for (i = 0; i < S.n; i++) S.cts.push(0);
            // stss — sync samples (absent ⇒ every sample is sync)
            if (stss) {
                p = stss.start + stss.hdr + 4; n = u32(B, p); p += 4;
                var syncSet = {}; for (i = 0; i < n; i++) { syncSet[u32(B, p)] = 1; p += 4; }
                for (i = 0; i < S.n; i++) { var isS = !!syncSet[i + 1]; S.sync.push(isS); if (!isS) S.anyNonSync = true; }
            } else for (i = 0; i < S.n; i++) S.sync.push(true);
            // chunks — stco/co64 offsets + stsc runs
            var offsets = [];
            if (co64) { p = co64.start + co64.hdr + 4; n = u32(B, p); p += 4; for (i = 0; i < n; i++) { offsets.push(u64(B, p)); p += 8; } }
            else { p = stco.start + stco.hdr + 4; n = u32(B, p); p += 4; for (i = 0; i < n; i++) { offsets.push(u32(B, p)); p += 4; } }
            var runs = []; p = stsc.start + stsc.hdr + 4; n = u32(B, p); p += 4;
            for (i = 0; i < n; i++) { runs.push({ first: u32(B, p), spc: u32(B, p + 4), descIdx: u32(B, p + 8) }); p += 12; }
            var total = 0, ri = 0;
            for (i = 0; i < offsets.length; i++) {
                while (ri + 1 < runs.length && runs[ri + 1].first <= i + 1) ri++;
                var run = runs[ri];
                if (!run || run.first > i + 1) throw new Error('flat: stsc does not cover chunk ' + (i + 1) + ' for track ' + t.id);
                var cnt = run.spc;
                if (total + cnt > S.n) cnt = S.n - total;   // a table that overshoots: keep what exists
                if (cnt > 0) t.chunks.push({ offset: offsets[i], count: cnt, descIdx: run.descIdx || 1 });
                total += cnt;
            }
            if (total !== S.n) throw new Error('flat: chunks describe ' + total + ' samples, tables ' + S.n + ' for track ' + t.id);
            readEdits(B, t);
        });
        return init;
    }
    // edts/elst — how the media timeline is presented
    function readEdits(B, t) {
        var edts = child(t.trak, 'edts'), elst = edts && child(edts, 'elst');
        if (!elst) return;
        var ever = B[elst.start + elst.hdr], p = elst.start + elst.hdr + 4, n = u32(B, p); p += 4;
        t.edits = [];
        for (var i = 0; i < n; i++) {
            if (ever === 1) { t.edits.push({ segDur: u64(B, p), mediaTime: i64(B, p + 8), rate: (B[p + 16] << 8) | B[p + 17] }); p += 20; }
            else { t.edits.push({ segDur: u32(B, p), mediaTime: i32(B, p + 4), rate: (B[p + 8] << 8) | B[p + 9] }); p += 12; }
        }
    }
    /* A unit track: one macro-sample per chunk (its samples, contiguous bytes), and
       `t.unit.first[m]` — the index of the macro's first sample. The same stsc walk
       as the per-sample reader, the same overshoot rule. */
    function readUnitChunks(B, t, unit, stsc, stco, co64) {
        var S = t.samples, p, n, i, offsets = [];
        if (co64) { p = co64.start + co64.hdr + 4; n = u32(B, p); p += 4; for (i = 0; i < n; i++) { offsets.push(u64(B, p)); p += 8; } }
        else { p = stco.start + stco.hdr + 4; n = u32(B, p); p += 4; for (i = 0; i < n; i++) { offsets.push(u32(B, p)); p += 4; } }
        var runs = []; p = stsc.start + stsc.hdr + 4; n = u32(B, p); p += 4;
        for (i = 0; i < n; i++) { runs.push({ first: u32(B, p), spc: u32(B, p + 4), descIdx: u32(B, p + 8) }); p += 12; }
        var total = 0, ri = 0, first = [];
        for (i = 0; i < offsets.length; i++) {
            while (ri + 1 < runs.length && runs[ri + 1].first <= i + 1) ri++;
            var run = runs[ri];
            if (!run || run.first > i + 1) throw new Error('flat: stsc does not cover chunk ' + (i + 1) + ' for track ' + t.id);
            var cnt = run.spc;
            if (total + cnt > unit.frames) cnt = unit.frames - total;
            if (cnt > 0) {
                t.chunks.push({ offset: offsets[i], count: 1, descIdx: run.descIdx || 1 });
                S.dur.push(cnt * unit.dur); S.size.push(cnt * unit.size); S.sync.push(true); S.cts.push(0);
                first.push(total);
            }
            total += cnt;
        }
        if (total !== unit.frames) throw new Error('flat: chunks describe ' + total + ' samples, tables ' + unit.frames + ' for track ' + t.id);
        S.n = S.dur.length;
        unit.first = first;
        t.unit = unit;
    }

    // ── build a flat moov from the track model ──────────────────────────────
    function copyBox(w, bytes, box) { w.bytes(bytes.subarray(box.start, box.start + box.size)); }
    /**
     * buildMoov(init, opts) — mvhd/tkhd/mdhd and every header box are copied from
     * the source moov; durations are patched; the stbl is rebuilt from the track
     * model. opts.tracks narrows the output to a subset (a cut drops a track that
     * has no sample in the window). A track carrying `editsOut` gets THAT edit
     * list instead of the source edts (null = none); `movieDurOut` overrides the
     * presented duration (movie timescale) the media total would otherwise imply.
     */
    /* A concat writes tracks that come from DIFFERENT source moovs (the picture
       from one file, the sound from another), so a track may carry its own
       bytes `t.B`, its own stsd `t.stsdBytes`, a new track id `t.idOut`, and
       `t.cleanTrak` — keep only tkhd/edts/mdia (a tref or udta of the source
       names tracks and metadata that no longer exist in the join).
       `opts.nextTrackId` patches mvhd.next_track_ID to match. Every one of
       these is absent for the flatten and the cut, which behave as before. */
    function buildMoov(init, opts) {
        opts = opts || {};
        var w = new Writer(), B = init.bytes, tracks = opts.tracks || init.tracks;
        // durations
        var movieDur = 0;
        tracks.forEach(function (t) {
            // The muxer gives the LAST sample of a fragmented track the duration the
            // encoder reported — 0 when the chunk carried none (captured frames do
            // not) — which in a flat file puts the final sample at the same decode
            // time as the one before it (ffmpeg: «non monotonically increasing dts»).
            // Its neighbour's duration is the honest estimate the flat muxer uses too.
            var S = t.samples, n = S.n;
            if (n >= 2 && S.dur[n - 1] === 0) S.dur[n - 1] = S.dur[n - 2];
            var total = 0; for (var i = 0; i < n; i++) total += S.dur[i];
            t.mediaDur = total;
            t.movieDur = t.movieDurOut != null ? t.movieDurOut : Math.round(total * init.movieTs / t.mediaTs);
            if (t.movieDur > movieDur) movieDur = t.movieDur;
        });
        w.box('moov', function () {
            // mvhd — copy and patch duration (version-aware)
            var mv = init.mvhd, p = mv.start + mv.hdr, ver = B[p];
            var mvBytes = B.slice(mv.start, mv.start + mv.size);
            var durOff = mv.hdr + 4 + (ver === 1 ? 8 + 8 + 4 : 4 + 4 + 4);
            if (ver === 1) putU64(mvBytes, durOff, movieDur); else putU32(mvBytes, durOff, movieDur > 0xffffffff ? 0xffffffff : movieDur);
            if (opts.nextTrackId) putU32(mvBytes, mvBytes.length - 4, opts.nextTrackId);
            w.bytes(mvBytes);
            tracks.forEach(function (t) {
                var TB = t.B || B;
                w.box('trak', function () {
                    // tkhd — copy, patch duration (and the id, when the join renumbers)
                    var tk = t.tkhd, tp = tk.start + tk.hdr, tver = TB[tp];
                    var tkBytes = TB.slice(tk.start, tk.start + tk.size);
                    var tdOff = tk.hdr + 4 + (tver === 1 ? 8 + 8 + 4 + 4 : 4 + 4 + 4 + 4);
                    if (tver === 1) putU64(tkBytes, tdOff, t.movieDur); else putU32(tkBytes, tdOff, t.movieDur > 0xffffffff ? 0xffffffff : t.movieDur);
                    if (t.idOut) putU32(tkBytes, tk.hdr + 4 + (tver === 1 ? 16 : 8), t.idOut);
                    w.bytes(tkBytes);
                    var ownEdits = t.editsOut !== undefined;
                    if (ownEdits && t.editsOut && t.editsOut.length) writeEdts(w, t.editsOut);
                    // everything else in trak except mdia is copied verbatim (edts, udta, …)
                    t.trak.children.forEach(function (c) {
                        if (c.type === 'tkhd' || c.type === 'mdia' || (ownEdits && c.type === 'edts')) return;
                        if (t.cleanTrak && c.type !== 'edts') return;
                        copyBox(w, TB, c);
                    });
                    w.box('mdia', function () {
                        var md = t.mdhd, mp = md.start + md.hdr, mver = TB[mp];
                        var mdBytes = TB.slice(md.start, md.start + md.size), mdHdr = md.hdr;
                        if (mver === 0 && t.mediaDur > 0xffffffff) { mdBytes = mdhdV1(mdBytes, md.hdr); mdHdr = 8; }   // a long join at a fine timescale
                        mver = mdBytes[mdHdr];
                        var mdOff = mdHdr + 4 + (mver === 1 ? 8 + 8 + 4 : 4 + 4 + 4);
                        if (mver === 1) putU64(mdBytes, mdOff, t.mediaDur); else putU32(mdBytes, mdOff, t.mediaDur > 0xffffffff ? 0xffffffff : t.mediaDur);
                        if (t.writeTs) putU32(mdBytes, mdHdr + 4 + (mver === 1 ? 16 : 8), t.mediaTs);   // a join on a clock of its own
                        w.bytes(mdBytes);
                        t.mdia.children.forEach(function (c) { if (c.type !== 'mdhd' && c.type !== 'minf') copyBox(w, TB, c); });
                        w.box('minf', function () {
                            t.minf.children.forEach(function (c) { if (c.type !== 'stbl') copyBox(w, TB, c); });
                            w.box('stbl', function () {
                                if (t.stsdBytes) w.bytes(t.stsdBytes);
                                else copyBox(w, TB, child(t.stbl, 'stsd'));
                                writeStbl(w, t);
                            });
                        });
                    });
                });
            });
            // no mvex: the file is flat
        });
        return { moov: w.result(), movieDurMs: init.movieTs ? movieDur / init.movieTs * 1000 : 0 };
    }
    function putU32(u8, o, v) { u8[o] = (v >>> 24) & 255; u8[o + 1] = (v >>> 16) & 255; u8[o + 2] = (v >>> 8) & 255; u8[o + 3] = v & 255; }
    function putU64(u8, o, v) { putU32(u8, o, Math.floor(v / 4294967296)); putU32(u8, o + 4, v >>> 0); }
    // mdhd v0 → v1 (64-bit times and duration), same timescale and language.
    function mdhdV1(v0, hdr) {
        var p = hdr, out = new Uint8Array(8 + 36);
        putU32(out, 0, out.length); out.set(v0.subarray(4, 8), 4);            // size, 'mdhd'
        out[8] = 1; out.set(v0.subarray(p + 1, p + 4), 9);                    // version 1, flags
        putU64(out, 12, u32(v0, p + 4)); putU64(out, 20, u32(v0, p + 8));    // creation, modification
        out.set(v0.subarray(p + 12, p + 16), 28);                            // timescale
        putU64(out, 32, u32(v0, p + 16));                                    // duration (patched by the caller)
        out.set(v0.subarray(p + 20, p + 24), 40);                            // language, pre_defined
        return out;
    }

    function writeEdts(w, edits) {
        var wide = edits.some(function (e) { return e.segDur > 0xffffffff || e.mediaTime > 0x7fffffff; });
        w.box('edts', function () {
            w.fullbox('elst', wide ? 1 : 0, 0, function () {
                this.u32(edits.length);
                for (var i = 0; i < edits.length; i++) {
                    var e = edits[i];
                    if (wide) { this.u64(e.segDur); this.i64(e.mediaTime); } else { this.u32(e.segDur); this.i32(e.mediaTime); }
                    this.u16(e.rate != null ? e.rate : 1); this.u16(0);
                }
            });
        });
    }

    function writeStbl(w, t) {
        var S = t.samples, n = S.n;
        // A unit track (see unitShape) carries macro-samples; its tables are written
        // per SAMPLE, exactly as the per-sample model wrote them: one stts run, a
        // constant stsz, chunks counted in samples (place() counts them so).
        if (t.unit) {
            var frames = 0; for (var c0 = 0; c0 < t.chunks.length; c0++) frames += t.chunks[c0].count;
            w.fullbox('stts', 0, 0, function () { this.u32(1); this.u32(frames); this.u32(t.unit.dur); });
            writeStsc(w, t);
            w.fullbox('stsz', 0, 0, function () { this.u32(t.unit.size); this.u32(frames); });
            writeCo64(w, t);
            return;
        }
        // stts — run-length of decode deltas
        w.fullbox('stts', 0, 0, function () {
            var runs = []; var i = 0;
            while (i < n) { var d = S.dur[i], c = 1; while (i + c < n && S.dur[i + c] === d) c++; runs.push([c, d]); i += c; }
            this.u32(runs.length); for (var r = 0; r < runs.length; r++) { this.u32(runs[r][0]); this.u32(runs[r][1]); }
        });
        // ctts — only when any composition offset is non-zero
        if (S.anyCts) {
            var neg = false; for (var k = 0; k < n; k++) if (S.cts[k] < 0) { neg = true; break; }
            w.fullbox('ctts', neg ? 1 : 0, 0, function () {
                var runs = []; var i = 0;
                while (i < n) { var d = S.cts[i], c = 1; while (i + c < n && S.cts[i + c] === d) c++; runs.push([c, d]); i += c; }
                this.u32(runs.length); for (var r = 0; r < runs.length; r++) { this.u32(runs[r][0]); this.i32(runs[r][1]); }
            });
        }
        // stss — sync samples, only if some are not sync (audio: all sync → omitted)
        if (S.anyNonSync) {
            w.fullbox('stss', 0, 0, function () {
                var idx = []; for (var i = 0; i < n; i++) if (S.sync[i]) idx.push(i + 1);
                this.u32(idx.length); for (var j = 0; j < idx.length; j++) this.u32(idx[j]);
            });
        }
        writeStsc(w, t);
        // stsz
        w.fullbox('stsz', 0, 0, function () {
            var constant = n > 0, s0 = n ? S.size[0] : 0;
            for (var i = 1; i < n && constant; i++) if (S.size[i] !== s0) constant = false;
            if (constant) { this.u32(s0); this.u32(n); }
            else { this.u32(0); this.u32(n); for (var j = 0; j < n; j++) this.u32(S.size[j]); }
        });
        writeCo64(w, t);
    }
    // stsc — one chunk per run; compress equal consecutive (samples_per_chunk, description)
    function writeStsc(w, t) {
        w.fullbox('stsc', 0, 0, function () {
            var entries = [], last = '';
            for (var c = 0; c < t.chunks.length; c++) {
                var spc = t.chunks[c].count, di = t.chunks[c].descIdx || 1, key = spc + '/' + di;
                if (key !== last) { entries.push([c + 1, spc, di]); last = key; }
            }
            this.u32(entries.length); for (var e = 0; e < entries.length; e++) { this.u32(entries[e][0]); this.u32(entries[e][1]); this.u32(entries[e][2]); }
        });
    }
    // co64 — absolute offsets of each chunk (a take can exceed 4 GB)
    function writeCo64(w, t) {
        w.fullbox('co64', 0, 0, function () {
            this.u32(t.chunks.length); for (var c = 0; c < t.chunks.length; c++) this.u64(t.chunks[c].offset);
        });
    }

    // ── damage in the middle of a take ──────────────────────────────────────
    // A stretch of the file that is not a fragment — zeros where writes never
    // landed, a torn fragment that is NOT the last one — used to end the plan:
    // the caller wrote the new moov there and truncated, so every fragment
    // after the damage went with it (a 20-minute take kept its first 17 s,
    // 29.10.2026). Now the plan looks for the next whole fragment (a 'moof'
    // of a sane size whose 'mdat' follows) and goes on from there; the damaged
    // stretch is wrapped into a 'free' box, so a player walking the top-level
    // boxes steps over it. Nothing after it → it was the torn tail of a crash,
    // cut as before.
    var RESYNC_CHUNK = 4 * 1048576, MOOF_MAX = 64 * 1048576;
    async function nextFragment(readAt, from, fileSize) {
        for (var pos = from; pos + 16 <= fileSize; pos += RESYNC_CHUNK) {
            var buf = await readAt(pos, Math.min(RESYNC_CHUNK + 16, fileSize - pos));
            for (var i = 4; i + 4 <= buf.length; i++) {
                if (buf[i] !== 0x6d || buf[i + 1] !== 0x6f || buf[i + 2] !== 0x6f || buf[i + 3] !== 0x66) continue;   // 'moof'
                var at = pos + i - 4, sz = u32(buf, i - 4);
                if (at < from || sz < 24 || sz > MOOF_MAX || at + sz + 8 > fileSize) continue;
                var nx = await readAt(at + sz, 8);
                if (nx.length === 8 && str4(nx, 4) === 'mdat') return at;
            }
        }
        return -1;
    }
    // A top-level 'free' box header covering `len` bytes (64-bit size above 4 GiB).
    function freeHeader(len) {
        if (len < 4294967296) return new Uint8Array([len >>> 24 & 255, len >>> 16 & 255, len >>> 8 & 255, len & 255, 0x66, 0x72, 0x65, 0x65]);
        var b = new Uint8Array(16); b.set([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65]);
        var hi = Math.floor(len / 4294967296), lo = len >>> 0;
        b.set([hi >>> 24 & 255, hi >>> 16 & 255, hi >>> 8 & 255, hi & 255, lo >>> 24 & 255, lo >>> 16 & 255, lo >>> 8 & 255, lo & 255], 8);
        return b;
    }

    // ── the flatten plan ────────────────────────────────────────────────────
    /**
     * plan(readAt, fileSize) → {
     *   ok, reason,
     *   truncateTo,           // cut the file here (drops a torn fragment and the mfra)
     *   patches: [{at, bytes}], // 4-byte type renames (+ a flat ftyp when it fits)
     *   moov,                 // Uint8Array to append at truncateTo
     *   fragments, dropped,   // complete fragments used / torn fragments dropped
     *   durationMs, tracks: [{id, handler, samples, mediaDurMs}]
     * }
     * Nothing is written here; the caller applies truncate → patches → append.
     */
    async function plan(readAt, fileSize) {
        var hdr = await readAt(0, Math.min(fileSize, 64));
        if (hdr.length < 8 || str4(hdr, 4) !== 'ftyp') return { ok: false, reason: 'not-mp4' };
        var ftypSize = u32(hdr, 0);
        var off = ftypSize, init = null, patches = [], fragments = 0, dropped = 0, lastGood = ftypSize, guard = 0;
        var pendingMoof = null;   // a complete moof waiting for its data to be verified against fileSize
        var brandBytes = hdr.subarray(0, Math.min(ftypSize, hdr.length));
        var holes = 0, holeBytes = 0;
        while (off + 8 <= fileSize && guard++ < MAX_TOP_LEVEL_BOXES) {
            var h = await readAt(off, Math.min(16, fileSize - off));
            if (h.length < 8) break;
            var size = u32(h, 0), type = str4(h, 4), bhdr = 8;
            if (size === 1) { if (h.length < 16) break; size = u64(h, 8); bhdr = 16; }
            else if (size === 0) size = fileSize - off;      // "to end of file" — only legal for the last box
            var bad = -1;                                     // where unusable bytes start
            if (size < bhdr) {
                if (!init) return { ok: false, reason: 'corrupt-box@' + off };
                bad = off;
            } else {
                var complete = off + size <= fileSize;
                if (type === 'moov') {
                    if (!complete) return { ok: false, reason: 'init-moov-truncated' };
                    if (init) return { ok: false, reason: 'second-moov' };   // already flat or foreign
                    init = parseInit(await readAt(off, size));
                    patches.push({ at: off + 4, bytes: new Uint8Array([0x66, 0x72, 0x65, 0x65]) });   // 'free'
                    lastGood = off + size;
                } else if (type === 'moof') {
                    if (!init) return { ok: false, reason: 'moof-before-moov' };
                    if (!complete) bad = off;
                    else pendingMoof = { at: off, size: size, bytes: await readAt(off, size) };
                } else if (type === 'mdat') {
                    if (!pendingMoof) { /* stray data before any moof — skip it */ }
                    else if (!complete) { bad = pendingMoof.at; pendingMoof = null; }
                    else {
                        // snapshot the sample arrays so a bad moof can be rolled back
                        var snap = init.tracks.map(function (t) { return { n: t.samples.n, ch: t.chunks.length }; });
                        var range = null;
                        try { range = parseMoof(pendingMoof.bytes, pendingMoof.at, init); } catch (e) { range = null; }
                        if (!range || range.dataMax > fileSize || range.dataMax > off + size) { rollback(init, snap); bad = pendingMoof.at; pendingMoof = null; }
                        else {
                            patches.push({ at: pendingMoof.at + 4, bytes: new Uint8Array([0x66, 0x72, 0x65, 0x65]) });
                            fragments++; lastGood = off + size; pendingMoof = null;
                        }
                    }
                } else if (type === 'mfra' || type === 'free' || type === 'skip') {
                    // trailing index / padding — dropped by the truncate below
                    if (!complete) break;
                } else {
                    // not a box this muxer writes: zeros where writes never landed, garbage
                    if (!init) break;
                    bad = off;
                }
            }
            if (bad >= 0) {
                var resume = await nextFragment(readAt, bad + 8, fileSize);
                if (resume < 0) { dropped++; break; }         // nothing whole after it: the torn tail of a crash
                patches.push({ at: bad, bytes: freeHeader(resume - bad) });
                holes++; holeBytes += resume - bad;
                off = resume; pendingMoof = null;
                continue;
            }
            off += size;
        }
        if (!init) return { ok: false, reason: 'no-init-moov' };
        if (!fragments) return { ok: false, reason: 'no-complete-fragment', dropped: dropped };
        // ftyp: fMP4 brands (iso5/iso6) → the flat brands players expect, when the box is the same size
        if (ftypSize === 28 && brandBytes.length >= 28 && str4(brandBytes, 8) === 'iso5') {
            var flatFtyp = new Uint8Array(28); flatFtyp.set(brandBytes.subarray(0, 8));
            var s = 'isom' + '\u0000\u0002\u0000\u0000' + 'isom' + 'avc1' + 'mp41';
            for (var i = 0; i < 20; i++) flatFtyp[8 + i] = s.charCodeAt(i);
            var hasAvc = init.tracks.some(function (t) { var st = child(t.stbl, 'stsd'); return st && indexOfAscii(init.bytes, st.start, st.start + st.size, 'avc1') >= 0; });
            if (hasAvc) patches.push({ at: 0, bytes: flatFtyp });
        }
        var built = buildMoov(init);
        return {
            ok: true, truncateTo: lastGood, patches: patches, moov: built.moov, fragments: fragments, dropped: dropped, holes: holes, holeBytes: holeBytes,
            durationMs: Math.round(built.movieDurMs),
            tracks: init.tracks.map(function (t) { return { id: t.id, handler: t.handler, samples: t.samples.n, mediaDurMs: Math.round(t.mediaDur / t.mediaTs * 1000) }; })
        };
    }
    function rollback(init, snap) {
        init.tracks.forEach(function (t, i) {
            var S = t.samples, n = snap[i].n;
            S.dur.length = n; S.size.length = n; S.sync.length = n; S.cts.length = n; S.n = n;
            t.chunks.length = snap[i].ch;
            S.anyCts = false; S.anyNonSync = false;
            for (var k = 0; k < n; k++) { if (S.cts[k] !== 0) S.anyCts = true; if (!S.sync[k]) S.anyNonSync = true; }
        });
    }
    function indexOfAscii(u8, from, to, s) {
        outer: for (var i = from; i + s.length <= to; i++) { for (var j = 0; j < s.length; j++) if (u8[i + j] !== s.charCodeAt(j)) continue outer; return i; }
        return -1;
    }

    // ── the cut plan ────────────────────────────────────────────────────────
    // Presentation of a track: media time `mediaTime` (media ticks) is shown at
    // presentation zero, after `delay` seconds of nothing (an empty edit). Only
    // the common shapes are honoured — a single non-empty edit, optionally
    // preceded by one empty edit; anything else (multi-segment, rate ≠ 1) is
    // read as «no edit» so the cut still copies the samples faithfully.
    function presentationOf(t) {
        var po = 0, delay = 0;
        if (t.edits && t.edits.length) {
            var e0 = t.edits[0], e1 = t.edits[1];
            if (e0.mediaTime === -1 && e1 && e1.mediaTime >= 0) { delay = e0.segDur / (t.movieTsRef || 1); po = e1.mediaTime; }
            else if (e0.mediaTime >= 0) po = e0.mediaTime;
        }
        return { po: po, delay: delay };
    }
    function sampleOffsets(t) {
        var S = t.samples, out = new Float64Array(S.n), i = 0;
        for (var c = 0; c < t.chunks.length; c++) {
            var pos = t.chunks[c].offset;
            for (var k = 0; k < t.chunks[c].count; k++) { out[i] = pos; pos += S.size[i]; i++; }
        }
        return out;
    }
    function decodeTimes(t) {
        var S = t.samples, out = new Float64Array(S.n), acc = 0;
        for (var i = 0; i < S.n; i++) { out[i] = acc; acc += S.dur[i]; }
        return out;
    }
    function descIdxOf(t) {
        var out = new Uint32Array(t.samples.n), i = 0;
        for (var c = 0; c < t.chunks.length; c++) for (var k = 0; k < t.chunks[c].count; k++) out[i++] = t.chunks[c].descIdx || 1;
        return out;
    }

    /**
     * cutPlan(init, startSec, endSec, opts?) → {
     *   ok, reason,
     *   ftyp, moov,             // Uint8Array — the output's head (moov FIRST)
     *   mdatHeader,             // Uint8Array — 8 or 16 bytes, sized for the data
     *   parts: [{at, len}],     // source byte ranges, in output order (the mdat body)
     *   size,                   // bytes of the whole output
     *   startMs, endMs,         // the presented window: start = the video keyframe the cut opens on,
     *                           // or with opts.exact the requested start (see P0 below)
     *   durationMs, tracks: [{id, handler, samples, mediaDurMs, firstPresMs}]
     * }
     * `init` comes from readFlat(); nothing here reads or writes the file.
     */
    function cutPlan(init, startSec, endSec, opts) {
        if (!(endSec > startSec)) return { ok: false, reason: 'empty-range' };
        var movieTs = init.movieTs || 1000;
        var tracks = init.tracks.filter(function (t) { return t.samples.n > 0 && t.chunks.length > 0; });
        if (!tracks.length) return { ok: false, reason: 'no-samples' };
        tracks.forEach(function (t) {
            t.movieTsRef = movieTs;
            var pr = presentationOf(t);
            t.presOff = pr.po; t.presDelay = pr.delay;
            t.dts = decodeTimes(t); t.offsets = sampleOffsets(t); t.descs = descIdxOf(t);
            t.isVideo = t.handler === 'vide';
        });
        function presSec(t, i) { return (t.dts[i] + t.samples.cts[i] - t.presOff) / t.mediaTs + t.presDelay; }
        function presEndSec(t, i) { return presSec(t, i) + t.samples.dur[i] / t.mediaTs; }
        // A unit track's SAMPLE f, on the very expressions above: its decode time is
        // f·dur exactly (an integer sum), its composition offset 0.
        function unitPres(t, f) { return (f * t.unit.dur + 0 - t.presOff) / t.mediaTs + t.presDelay; }
        function unitPresEnd(t, f) { return unitPres(t, f) + t.unit.dur / t.mediaTs; }
        // the first f in [0, n) where a monotone predicate turns true; n if never
        function firstTrue(n, pred) { var lo = 0, hi = n; while (lo < hi) { var mid = Math.floor((lo + hi) / 2); if (pred(mid)) hi = mid; else lo = mid + 1; } return lo; }
        // the macro-sample (chunk) holding sample f
        function macroOf(first, f) { var lo = 0, hi = first.length - 1; while (lo < hi) { var mid = Math.ceil((lo + hi) / 2); if (first[mid] <= f) lo = mid; else hi = mid - 1; } return lo; }

        // The video anchors the window: a copy cut opens on the last keyframe at
        // or before the requested start, and every track is presented from THAT
        // instant, so audio and video keep the alignment the source had.
        var T0 = startSec, T1 = endSec;
        var v = null; for (var vi = 0; vi < tracks.length; vi++) if (tracks[vi].isVideo) { v = tracks[vi]; break; }
        var vFrom = -1;
        if (v) {
            var firstSync = -1;
            for (var i = 0; i < v.samples.n; i++) {
                if (!v.samples.sync[i]) continue;
                if (firstSync < 0) firstSync = i;
                if (presSec(v, i) <= startSec + 1e-6) vFrom = i; else if (vFrom >= 0) break;
            }
            if (vFrom < 0) vFrom = firstSync >= 0 ? firstSync : 0;
            T0 = presSec(v, vFrom);
            if (!(T1 > T0)) return { ok: false, reason: 'empty-range' };
        }
        // opts.exact: the samples still open on that keyframe — a decoder needs
        // it — but the window is PRESENTED from the requested start: the edit
        // lists below hide the frames in between, which is what FFmpeg's
        // `-ss … -c copy` writes (/mute-video's trim, 02.10.2026). A player that
        // ignores edit lists shows them, exactly as it does on FFmpeg's file.
        // Under a millisecond (less than any frame) is the keyframe itself: a cut that
        // opens on it gets nothing to hide, exactly as without the option.
        var P0 = (opts && opts.exact && startSec - T0 > 0.001) ? startSec : T0;

        var selected = [];
        tracks.forEach(function (t) {
            var from = -1, to = -1, n = t.samples.n;
            if (t === v) {
                from = vFrom;
                for (var i = from; i < n; i++) if (presSec(t, i) < T1 - 1e-6) to = i;
                if (to < from) to = from;
            } else if (t.unit) {
                // the loop below, by bisection over the samples (both predicates are monotone)
                var F = t.unit.frames;
                from = firstTrue(F, function (f) { return unitPresEnd(t, f) > P0 + 1e-6; });
                if (from >= F) from = -1;
                to = firstTrue(F, function (f) { return !(unitPres(t, f) < T1 - 1e-6); }) - 1;
                if (from < 0 || to < from) return;
                if (P0 > T0 && from > 0) from -= 1;
            } else {
                for (var j = 0; j < n; j++) { if (from < 0 && presEndSec(t, j) > P0 + 1e-6) from = j; if (presSec(t, j) < T1 - 1e-6) to = j; }
                if (from < 0 || to < from) return;   // nothing of this track plays in the window
                // An exact window keeps the frame before it as well, hidden by the
                // edit list: an AAC frame decodes against the one before it.
                if (P0 > T0 && from > 0) from -= 1;
            }
            t.sel = { from: from, to: to };
            selected.push(t);
        });
        if (!selected.length) return { ok: false, reason: 'no-samples-in-range' };

        // Per-track output timeline: samples [from..to] in decode order, decode
        // times re-based on the first one; an edit list places presentation.
        var outTracks = selected.map(function (t) {
            var S = t.samples, from = t.sel.from, to = t.sel.to, n = to - from + 1, o;
            var dtsFirst, firstPres = Infinity, lastPresEnd = 0, ctsFirst = Infinity;
            if (t.unit) {
                // samples [from..to] as the macros that hold them, the two at the ends
                // cut down to the window (a unit sample is whole bytes of its own)
                var U = t.unit, mac = [];
                for (var m = macroOf(U.first, from), mTo = macroOf(U.first, to); m <= mTo; m++) {
                    var f0 = U.first[m], a = Math.max(from, f0), b = Math.min(to, f0 + S.dur[m] / U.dur - 1), cnt = b - a + 1;
                    mac.push({ at: t.offsets[m] + (a - f0) * U.size, n: cnt, len: cnt * U.size, descIdx: t.descs[m] });
                }
                o = { trak: t.trak, tkhd: t.tkhd, mdia: t.mdia, mdhd: t.mdhd, minf: t.minf, stbl: t.stbl, id: t.id, mediaTs: t.mediaTs, handler: t.handler,
                      samples: { n: mac.length, dur: mac.map(function (x) { return x.n * U.dur; }), size: mac.map(function (x) { return x.len; }),
                                 sync: mac.map(function () { return true; }), cts: mac.map(function () { return 0; }), anyCts: false, anyNonSync: false },
                      chunks: [], src: t, unit: U, mac: mac, frames: n };
                dtsFirst = from * U.dur;
                firstPres = unitPres(t, from); lastPresEnd = unitPresEnd(t, to); ctsFirst = 0;
            } else {
                o = { trak: t.trak, tkhd: t.tkhd, mdia: t.mdia, mdhd: t.mdhd, minf: t.minf, stbl: t.stbl, id: t.id, mediaTs: t.mediaTs, handler: t.handler,
                      samples: { n: n, dur: S.dur.slice(from, to + 1), size: S.size.slice(from, to + 1), sync: S.sync.slice(from, to + 1), cts: S.cts.slice(from, to + 1), anyCts: false, anyNonSync: false },
                      chunks: [], src: t, from: from, to: to };
                for (var i = 0; i < n; i++) { if (o.samples.cts[i] !== 0) o.samples.anyCts = true; if (!o.samples.sync[i]) o.samples.anyNonSync = true; }
                dtsFirst = t.dts[from];
                for (var k = from; k <= to; k++) { var ps = presSec(t, k); if (ps < firstPres) firstPres = ps; var pe = presEndSec(t, k); if (pe > lastPresEnd) lastPresEnd = pe; }
                // a loop, not Math.min.apply: a long take puts 150 000+ samples in one
                // window and V8 refuses ~120 k arguments («Maximum call stack size
                // exceeded», /video-trim «Разделить» on a 100-minute mp4, 20.10.2026)
                for (var ci = 0; ci < n; ci++) { var cv = t.dts[from + ci] + o.samples.cts[ci] - dtsFirst; if (cv < ctsFirst) ctsFirst = cv; }
            }
            var presEnd = Math.min(T1, lastPresEnd);
            var edits = [];
            if (firstPres > P0 + 0.5 / t.mediaTs) {
                // the track starts inside the window: nothing, then the track
                var delayMovie = Math.round((firstPres - P0) * movieTs);
                if (delayMovie > 0) edits.push({ segDur: delayMovie, mediaTime: -1, rate: 1 });
                edits.push({ segDur: Math.max(0, Math.round((presEnd - firstPres) * movieTs)), mediaTime: Math.max(0, Math.round(ctsFirst)), rate: 1 });
            } else {
                var mediaTime = Math.round(P0 * t.mediaTs) + t.presOff - Math.round(t.presDelay * t.mediaTs) - dtsFirst;
                if (mediaTime < 0) mediaTime = 0;
                edits.push({ segDur: Math.max(0, Math.round((presEnd - P0) * movieTs)), mediaTime: mediaTime, rate: 1 });
            }
            // a single edit that starts the media at 0 says nothing: omit it (the common
            // recorder case — no B-frames, no priming — stays as plain as the source)
            o.editsOut = (edits.length === 1 && edits[0].mediaTime === 0) ? null : edits;
            o.movieDurOut = edits.reduce(function (a, e) { return a + e.segDur; }, 0);
            o.firstPresSec = Math.max(firstPres, P0);
            o.presEndSec = presEnd;
            return o;
        });

        // A picture or sound track that covers the window in the source must cover it
        // in the cut. A misread table breaks exactly this and nothing else looks
        // wrong: on 04.11.2026 a signed ctts read unsigned put frame 14 onward hours
        // away, and the cut — 0.58 s of picture under 9 s of sound — went out six
        // times as a success; no caller got to its other lane. Refused instead
        // ('short-track'), every caller falls through (FFmpeg, re-encode). Honest
        // windows differ by rounding only; a sample's length of slack, ¼ s at least.
        // Text and timecode tracks are sparse by nature and not judged.
        for (var si = 0; si < selected.length; si++) {
            var st = selected[si], so = outTracks[si];
            if (st.handler !== 'vide' && st.handler !== 'soun') continue;
            var spanFirst, spanLast, slack = 0;
            if (st.unit) { spanFirst = unitPres(st, 0); spanLast = unitPresEnd(st, st.unit.frames - 1); }
            else {
                spanFirst = Infinity; spanLast = -Infinity;
                for (var sk = 0; sk < st.samples.n; sk++) {
                    var sp = presSec(st, sk), se = sp + st.samples.dur[sk] / st.mediaTs;
                    if (sp < spanFirst) spanFirst = sp;
                    if (se > spanLast) spanLast = se;
                }
            }
            for (var sd = 0; sd < so.samples.n; sd++) { var dd = so.samples.dur[sd] / st.mediaTs; if (dd > slack) slack = dd; }
            var want = Math.min(T1, spanLast) - Math.max(P0, spanFirst), got = so.presEndSec - so.firstPresSec;
            if (want - got > Math.max(0.25, 2 * slack)) {
                return { ok: false, reason: 'short-track', track: st.handler, wantMs: Math.round(want * 1000), gotMs: Math.round(got * 1000) };
            }
        }

        // Output order = SOURCE order of the window's samples, all tracks at
        // once: the source's own interleave is kept exactly, and the window of
        // an interleaved file is one contiguous byte range but for the two
        // straddling chunks at its ends. Two independent merges follow:
        //   • a slice of the source (a Blob part) = consecutive emitted samples
        //     that are contiguous in the source, whichever track — one to a
        //     handful of parts for a take, never one per sample;
        //   • a chunk of a track (stsc/co64) = consecutive emitted samples of the
        //     SAME track — contiguous in the output by construction.
        var parts = [], emitted = [];
        outTracks.forEach(function (o, ti) {
            var t = o.src, S = t.samples;
            // a unit track's macro is n samples that lie together: one entry, counted as n
            if (o.mac) { o.mac.forEach(function (x) { emitted.push({ track: ti, at: x.at, len: x.len, descIdx: x.descIdx, n: x.n }); }); return; }
            for (var i = o.from; i <= o.to; i++) emitted.push({ track: ti, at: t.offsets[i], len: S.size[i], descIdx: t.descs[i] });
        });
        emitted.sort(function (a, b) { return a.at - b.at; });
        for (var c = 0; c < emitted.length; c++) {
            var cd = emitted[c], lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.at + lastPart.len === cd.at) lastPart.len += cd.len;
            else parts.push({ at: cd.at, len: cd.len });
        }
        var mdatBytes = 0; parts.forEach(function (p) { mdatBytes += p.len; });
        var mdatHdrLen = (mdatBytes + 8 > 0xffffffff) ? 16 : 8;
        var ftyp = flatFtyp(init);
        // moov size does not depend on the offsets (co64 is fixed width): size it, then place.
        function place(base) {
            var pos = base, lastTrack = -1, chunk = null;
            outTracks.forEach(function (o) { o.chunks = []; });
            for (var e = 0; e < emitted.length; e++) {
                var s = emitted[e];
                if (chunk && s.track === lastTrack && chunk.descIdx === s.descIdx) chunk.count += s.n || 1;
                else { chunk = { offset: pos, count: s.n || 1, descIdx: s.descIdx }; outTracks[s.track].chunks.push(chunk); lastTrack = s.track; }
                pos += s.len;
            }
        }
        place(0);
        var first = buildMoov(init, { tracks: outTracks });
        var base = ftyp.length + first.moov.length + mdatHdrLen;
        place(base);
        var built = buildMoov(init, { tracks: outTracks });
        if (built.moov.length !== first.moov.length) return { ok: false, reason: 'moov-size-drift' };
        var mdatHeader = new Uint8Array(mdatHdrLen);
        if (mdatHdrLen === 16) { putU32(mdatHeader, 0, 1); putU64(mdatHeader, 8, mdatBytes + 16); } else putU32(mdatHeader, 0, mdatBytes + 8);
        mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74;
        var durationMs = Math.round(built.movieDurMs);
        return {
            ok: true, ftyp: ftyp, moov: built.moov, mdatHeader: mdatHeader,
            parts: parts.map(function (p) { return { at: p.at, len: p.len }; }),
            size: base + mdatBytes,
            startMs: Math.round(P0 * 1000), endMs: Math.round(P0 * 1000) + durationMs, durationMs: durationMs,
            tracks: outTracks.map(function (o) { return { id: o.id, handler: o.handler, samples: o.frames != null ? o.frames : o.samples.n, mediaDurMs: Math.round(o.mediaDur / o.mediaTs * 1000), firstPresMs: Math.round(o.firstPresSec * 1000) }; })
        };
    }
    function flatFtyp(init) {
        var hasAvc = init.tracks.some(function (t) { var st = child(t.stbl, 'stsd'); return st && indexOfAscii(init.bytes, st.start, st.start + st.size, 'avc1') >= 0; });
        var w = new Writer();
        w.box('ftyp', function () { this.ascii('isom'); this.u32(0x200); this.ascii('isom'); this.ascii('iso2'); if (hasAvc) this.ascii('avc1'); this.ascii('mp41'); });
        return w.result();
    }

    // ── the concat plan ─────────────────────────────────────────────────────
    /* A lossless JOIN is bookkeeping, like the cut: the samples stay where they are
       in their sources and a new moov describes them one after another. Until
       2026-09-26 /video-merge joined with FFmpeg-WASM `-f concat -c copy`, which is
       correct but builds the WHOLE output inside the wasm heap, reads it out as one
       ArrayBuffer and copies it again into a Blob — so the tool had to refuse any
       join whose output would not fit (0.9 GB on a 4 GB laptop): 77 sessions in
       30 days on the RU shard; report of 2026-09-25 — two clips of 254 + 301 MB,
       «клипы больше 3 мин. не склеить?». Here no sample byte passes through JS.

       What the join guarantees, and how:
       • Picture. Each clip keeps its bytes and its decode order; its times move to
         the clip's slot on one output clock (the clips' common timescale, else the
         largest one, with ABSOLUTE rounding so nothing drifts). Clips with different
         B-frame delays are re-based through composition offsets: D = the largest
         delay, one edit (mediaTime D), and every clip shows its first frame exactly
         at its slot.
       • Parameter sets. A track has one sample description (the first clip's); a
         clip whose avcC differs gets its own SPS/PPS IN-BAND in front of EVERY sync
         sample. FFmpeg's concat does the same for a file's first frame only
         (measured 2026-09-26: a Baseline clip after a High one decodes
         byte-identical that way); every keyframe keeps a seek INTO that clip right.
       • Sound. AAC frames are copied. Each clip's sound is placed so that its own
         time zero (after its priming edit) lands on its video slot to within half a
         frame (±10.7 ms at 48 kHz), and the error never accumulates: the previous
         clip's frames that run past the slot are dropped, a shortfall is filled with
         silent frames, a clip without sound is silence. FFmpeg's concat started the
         second clip's sound 47 ms late on the same fixtures (and kept the gap).
       • What it declines — `reason`, and `clip` = WHICH clip, so a caller can
         re-encode that one and join again: another sample-entry type or frame size,
         a different rotation matrix, a video edit list that hides frames or ends
         early, an audio format or timescale unlike the first sound, a source with
         several sample descriptions, silence needed but not supplied. */
    function bytesEqual(a, b) {
        if (a === b) return true;
        if (!a || !b || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }
    function descLen(u8, p) { var len = 0, n = 0, b; do { b = u8[p + n]; len = (len * 128) + (b & 0x7f); n++; } while ((b & 0x80) && n < 4); return { len: len, n: n }; }
    // esds → the AudioSpecificConfig (DecoderSpecificInfo) and objectTypeIndication
    function esdsInfo(u8, s, e) {
        var p = s + 4;                                   // fullbox version/flags
        if (u8[p] !== 0x03) return null;
        var d = descLen(u8, p + 1); p += 1 + d.n;
        var fl = u8[p + 2]; p += 3;                      // ES_ID, flags
        if (fl & 0x80) p += 2;                           // dependsOn_ES_ID
        if (fl & 0x40) p += 1 + u8[p];                   // URL
        if (fl & 0x20) p += 2;                           // OCR_ES_ID
        if (u8[p] !== 0x04) return null;
        d = descLen(u8, p + 1); p += 1 + d.n;
        var oti = u8[p]; p += 13;                        // oti, streamType, bufferSize, max/avg bitrate
        if (p >= e || u8[p] !== 0x05) return { oti: oti, asc: new Uint8Array(0) };
        d = descLen(u8, p + 1); p += 1 + d.n;
        if (p + d.len > e) return null;
        return { oti: oti, asc: u8.slice(p, p + d.len) };
    }
    function avcCInfo(u8, s, e) {
        if (e - s < 7) return null;
        var p = s + 5, nSps = u8[p++] & 31, sps = [], pps = [], l;
        for (var i = 0; i < nSps; i++) { l = (u8[p] << 8) | u8[p + 1]; p += 2; if (p + l > e) return null; sps.push(u8.slice(p, p + l)); p += l; }
        if (p >= e) return null;
        var nPps = u8[p++];
        for (var j = 0; j < nPps; j++) { l = (u8[p] << 8) | u8[p + 1]; p += 2; if (p + l > e) return null; pps.push(u8.slice(p, p + l)); p += l; }
        return { lengthSize: (u8[s + 4] & 3) + 1, sps: sps, pps: pps };
    }
    /**
     * sampleEntryOf(init, track) → what a join compares between clips:
     *   {count, type, entry (bytes), width, height, avcC:{lengthSize, sps[], pps[]}}
     *   for video; {count, type, entry, channels, sampleRate, asc, oti} for sound.
     */
    function sampleEntryOf(init, t) {
        var B = t.B || init.bytes, st = child(t.stbl, 'stsd');
        if (!st) return null;
        var p = st.start + st.hdr + 4, n = u32(B, p); p += 4;
        var e = p + u32(B, p);
        var info = { count: n, type: str4(B, p + 4), entry: B.subarray(p, e) }, kids = -1;
        if (t.handler === 'vide') {
            info.width = (B[p + 32] << 8) | B[p + 33]; info.height = (B[p + 34] << 8) | B[p + 35];
            kids = p + 86;                               // VisualSampleEntry fields end here
        } else if (t.handler === 'soun') {
            var ver = (B[p + 16] << 8) | B[p + 17];      // QuickTime sound entry v1/v2 carry more fields
            info.channels = (B[p + 24] << 8) | B[p + 25];
            info.sampleRate = u32(B, p + 32) >>> 16;
            kids = p + 36 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
        }
        function scan(o, end) {
            while (kids > 0 && o + 8 <= end) {
                var bs = u32(B, o), bt = str4(B, o + 4);
                if (bs < 8 || o + bs > end) break;
                if (bt === 'avcC') info.avcC = avcCInfo(B, o + 8, o + bs);
                if (/^(avcC|hvcC|av1C|vpcC)$/.test(bt) && !info.cfg) info.cfg = B.subarray(o, o + bs);   // the decoder's own record
                else if (bt === 'esds') { var es = esdsInfo(B, o + 8, o + bs); if (es) { info.asc = es.asc; info.oti = es.oti; } }
                else if (bt === 'wave') scan(o + 8, o + bs);   // QuickTime keeps the esds inside a wave box
                o += bs;
            }
        }
        scan(kids, e);
        return info;
    }
    function matrixOf(init, t) {
        var B = t.B || init.bytes, p = t.tkhd.start + t.tkhd.hdr, at = p + 4 + (B[p] === 1 ? 32 : 20) + 16;
        return B.subarray(at, at + 36);
    }
    // A clip's SPS/PPS as length-prefixed NAL units — what goes in front of its keyframes.
    function paramSetPrefix(avc) {
        var ls = avc.lengthSize, units = avc.sps.concat(avc.pps), n = 0, i, k;
        for (i = 0; i < units.length; i++) n += ls + units[i].length;
        var out = new Uint8Array(n), p = 0;
        for (i = 0; i < units.length; i++) {
            var L = units[i].length;
            for (k = ls - 1; k >= 0; k--) { out[p + k] = L & 255; L = Math.floor(L / 256); }
            p += ls; out.set(units[i], p); p += units[i].length;
        }
        return out;
    }
    // Where a track's own time zero is, in media ticks: the single edit's mediaTime,
    // minus an empty edit's wait (a track that starts late). NaN = a shape we do not read.
    function originOf(init, t) {
        var ed = t.edits;
        if (!ed || !ed.length) return 0;
        if (ed.length === 1 && ed[0].mediaTime >= 0 && ed[0].rate === 1) return ed[0].mediaTime;
        if (ed.length === 2 && ed[0].mediaTime === -1 && ed[1].mediaTime >= 0 && ed[1].rate === 1)
            return ed[1].mediaTime - Math.round(ed[0].segDur / (init.movieTs || 1000) * t.mediaTs);
        return NaN;
    }

    /**
     * concatPlan(clips, opts) → {
     *   ok, reason, clip,             // clip = the index a refusal is about
     *   ftyp, moov, mdatHeader,       // the output's head, moov FIRST
     *   parts: [{src, at, len} | {bytes}],   // the mdat body in output order
     *   size, durationMs,
     *   clips: [{startMs, durMs, audioErrMs}],  // each clip's slot; audioErrMs = where its sound landed
     *   audio: {frames, dropped, padded, skipped, maxErrMs} | null,
     *   injected                      // keyframes that got in-band parameter sets
     * }
     * clips[i] = { video: {init, track, src}, audio: {init, track, src} | null }
     *   `init` from readFlat, `track` one of init.tracks, `src` the caller's handle
     *   for the bytes (echoed back in `parts`).
     * opts.silence = {bytes, dur, asc} — ONE AAC frame of silence in the output sound's
     *   format; needed when a clip has no sound or its sound is short.
     * opts.brand = 'mp4' | 'mov'.
     */
    function concatPlan(clips, opts) {
        opts = opts || {};
        function no(reason, clip) { return { ok: false, reason: reason, clip: clip == null ? -1 : clip }; }
        if (!clips || !clips.length) return no('no-clips');
        var first = clips[0].video;
        if (!first || !first.track) return no('no-video', 0);
        var movieInit = first.init, movieTs = movieInit.movieTs || 1000;
        var refV = sampleEntryOf(first.init, first.track), refM = matrixOf(first.init, first.track);
        if (!refV) return no('video-description', 0);

        // ── picture: validate each clip, then place it on the output clock ──
        var V = [], tsOut = 0, c, k;
        for (c = 0; c < clips.length; c++) {
            var pv = clips[c].video;
            if (!pv || !pv.track || pv.track.handler !== 'vide' || !pv.track.samples.n || !pv.track.chunks.length) return no('no-video', c);
            var ev = sampleEntryOf(pv.init, pv.track);
            if (!ev || ev.count !== 1) return no('video-descriptions', c);
            if (ev.type !== refV.type || ev.width !== refV.width || ev.height !== refV.height) return no('video-format', c);
            if (!bytesEqual(matrixOf(pv.init, pv.track), refM)) return no('matrix', c);
            var inject = null;
            // What the DECODER is told — the codec record, not the whole entry: one encoder's
            // clips differ only in the btrt bitrate box, and that is not a reason to add bytes.
            if (!(ev.cfg && refV.cfg ? bytesEqual(ev.cfg, refV.cfg) : bytesEqual(ev.entry, refV.entry))) {
                if (!/^avc[13]$/.test(ev.type) || !ev.avcC || !refV.avcC || ev.avcC.lengthSize !== refV.avcC.lengthSize) return no('video-description', c);
                inject = paramSetPrefix(ev.avcC);
            }
            if (pv.track.mediaTs > tsOut) tsOut = pv.track.mediaTs;
            V.push({ t: pv.track, init: pv.init, src: pv.src, inject: inject, avcC: ev.avcC });
        }
        /* ⚠️ Once ONE clip carries its parameter sets in-band, EVERY clip must: a
           decoder keeps the last SPS/PPS it met in the stream, so a clip that
           relies on the sample description (the first clip's, equal to its own)
           is decoded with the previous clip's in-band sets. Measured 2026-09-26 on
           High → Baseline → High: the third clip came out as «reference count
           overflow / decode_slice_header error», 360 of 540 frames right. FFmpeg's
           concat puts them on every file's first frame for the same reason. */
        if (V.some(function (x) { return x.inject; })) {
            for (c = 0; c < V.length; c++) {
                if (!V[c].avcC) return no('video-description', c);
                if (!V[c].inject) V[c].inject = paramSetPrefix(V[c].avcC);
            }
        }
        var base = 0, D = 0;
        for (c = 0; c < V.length; c++) {
            var x = V[c], S = x.t.samples, n = S.n, r = tsOut / x.t.mediaTs;
            var durs = S.dur.slice(); if (n >= 2 && durs[n - 1] === 0) durs[n - 1] = durs[n - 2];
            var dts = 0, minPts = Infinity;
            x.dtsO = new Float64Array(n); x.ptsO = new Float64Array(n);
            for (k = 0; k < n; k++) {
                x.dtsO[k] = Math.round(dts * r);
                var pk = dts + S.cts[k]; x.ptsO[k] = Math.round(pk * r); if (pk < minPts) minPts = pk;
                dts += durs[k];
            }
            x.endO = Math.round(dts * r);
            var frame = n ? dts / n : 1;
            var P0 = originOf(x.init, x.t);
            if (!(P0 >= 0)) return no('video-edits', c);                          // a late start / unread shape
            if (x.t.edits && x.t.edits.length) {
                var seg = x.t.edits[x.t.edits.length - 1].segDur;
                var segMedia = seg / (x.init.movieTs || 1000) * x.t.mediaTs;
                if (seg > 0 && segMedia < (dts - P0) - frame) return no('video-edits', c);   // an edit that ends early is a cut
            } else P0 = minPts;
            if (minPts < P0 - 0.5) return no('video-preroll', c);                 // frames the edit hides (iPhone pre-roll)
            if (minPts > P0 + frame / 2) return no('video-edits', c);            // a gap before the first frame
            x.P0o = Math.round(P0 * r);
            if (x.P0o > D) D = x.P0o;
            x.base = base; base += x.endO;
            x.offsets = sampleOffsets(x.t);
        }
        var totalV = base;
        for (c = 0; c < V.length; c++) {
            var xv = V[c];
            for (k = 1; k < xv.t.samples.n; k++) if (!(xv.dtsO[k] > xv.dtsO[k - 1])) return no('video-timing', c);
            if (!(xv.endO > xv.dtsO[xv.t.samples.n - 1])) return no('video-timing', c);
        }

        // ── sound: one format for the whole track, placed clip by clip ──
        var A = null, sil = opts.silence || null, aTs = 0, refA = null, A0 = 0;
        var anyAudio = clips.some(function (cl) { return cl.audio && cl.audio.track; });
        if (anyAudio) {
            for (c = 0; c < clips.length; c++) {
                var pa = clips[c].audio; if (!pa || !pa.track) continue;
                if (pa.track.handler !== 'soun' || !pa.track.samples.n || !pa.track.chunks.length) return no('audio-track', c);
                var ea = sampleEntryOf(pa.init, pa.track);
                if (!ea || ea.count !== 1 || ea.type !== 'mp4a' || !ea.asc || !ea.asc.length) return no('audio-format', c);
                if (!refA) { refA = { c: c, e: ea, init: pa.init, t: pa.track }; aTs = pa.track.mediaTs; }
                else if (!bytesEqual(ea.asc, refA.e.asc) || ea.channels !== refA.e.channels) return no('audio-format', c);
                if (pa.track.mediaTs !== aTs) return no('audio-timescale', c);
                if (!(originOf(pa.init, pa.track) === originOf(pa.init, pa.track))) return no('audio-edits', c);
            }
            if (sil && !bytesEqual(sil.asc, refA.e.asc)) sil = null;             // silence in another format is no silence
            var c0 = clips[0].audio;
            A0 = (c0 && c0.track) ? Math.max(0, originOf(c0.init, c0.track)) : 0;
            /* ⚠️ Every AAC frame DECODES to the codec's frame length (1024 for AAC-LC),
               whatever its stts entry says. A source's LAST frame is written shorter
               (226 of 1024 in a 1.37 s clip) — an «end of stream, drop the rest» hint
               that holds only at the end of a stream. Carried into the middle of a
               join it is a lie: the decoder still emits 1024 samples and every later
               clip's sound slides late — measured +17 ms per junction, +36 ms by the
               fourth clip, while the plan believed it was within 10. So inside the
               join each frame weighs the track's nominal length, and the end of the
               sound is trimmed by the edit list instead. */
            var nom = (function (S) {
                var cnt = {}, best = 1024, bc = 0;
                for (var q = 0; q < S.n; q++) { var d = S.dur[q]; cnt[d] = (cnt[d] || 0) + 1; if (cnt[d] > bc) { bc = cnt[d]; best = d; } }
                return best;
            })(refA.t.samples);
            var frames = [], M = 0, stat = { dropped: 0, padded: 0, skipped: 0, maxErr: 0 }, clipErr = [];
            var pad = function (cl, count) {
                if (count <= 0) return true;
                if (!sil) return false;
                for (var q = 0; q < count; q++) { frames.push({ clip: cl, silence: true, len: sil.bytes.length, at0: M }); M += nom; }
                stat.padded += count; return true;
            };
            // Place the next thing at `want`: drop surplus tail frames, fill a shortfall.
            // Strict «more than half a frame» both ways, so the two never undo each other.
            var meet = function (cl, want) {
                while (frames.length && M - want > nom / 2) { frames.pop(); M -= nom; stat.dropped++; }
                if (want - M > nom / 2) return pad(cl, Math.round((want - M) / nom));
                return true;
            };
            var toA = function (vTicks) { return Math.round(vTicks / tsOut * aTs); };
            for (c = 0; c < clips.length; c++) {
                var pa2 = clips[c].audio, hasA = !!(pa2 && pa2.track);
                var slot = toA(V[c].base), next = toA(c + 1 < V.length ? V[c + 1].base : totalV);
                var prim = hasA ? originOf(pa2.init, pa2.track) : 0;
                var want = slot + A0 - prim;                        // this clip's frame 0, on the output media clock
                if (!meet(c, want)) return no('no-silence', c);
                if (!hasA) {
                    if (!meet(c, next + A0)) return no('no-silence', c);
                    clipErr.push(0);
                    continue;
                }
                // still ahead of the slot (nothing left to drop): skip this clip's own head frames
                var SA = pa2.track.samples, h = 0;
                while (h < SA.n - 1 && M - (want + h * nom) > nom / 2) h++;
                stat.skipped += h;
                var err = (M - (want + h * nom)) / aTs * 1000;
                clipErr.push(err);
                if (Math.abs(err) > stat.maxErr) stat.maxErr = Math.abs(err);
                var aOff = sampleOffsets(pa2.track);
                for (k = h; k < SA.n; k++) { frames.push({ clip: c, src: pa2.src, at: aOff[k], len: SA.size[k], at0: M }); M += nom; }
            }
            // the end: no sound past the picture, no hole before it
            var endA = toA(totalV) + A0;
            if (!meet(clips.length - 1, endA)) return no('no-silence', clips.length - 1);
            A = { frames: frames, M: M, stat: stat, clipErr: clipErr, nom: nom, pres: Math.min(M, endA) - A0 };
        }

        // ── output tracks (sample tables) ──
        var vS = { n: 0, dur: [], size: [], sync: [], cts: [], anyCts: false, anyNonSync: false }, injected = 0;
        var items = [];   // per clip: [{track, src, at, len, prefix, t}]
        for (c = 0; c < V.length; c++) {
            var xc = V[c], Sc = xc.t.samples, list = [];
            for (k = 0; k < Sc.n; k++) {
                var dur = (k + 1 < Sc.n ? xc.dtsO[k + 1] : xc.endO) - xc.dtsO[k];
                var cts = xc.ptsO[k] - xc.P0o + D - xc.dtsO[k];
                var pre = (xc.inject && Sc.sync[k]) ? xc.inject : null;
                if (pre) injected++;
                vS.dur.push(dur); vS.cts.push(cts); vS.sync.push(Sc.sync[k]);
                vS.size.push(Sc.size[k] + (pre ? pre.length : 0));
                if (cts !== 0) vS.anyCts = true;
                if (!Sc.sync[k]) vS.anyNonSync = true;
                list.push({ track: 0, src: xc.src, at: xc.offsets[k], len: Sc.size[k], prefix: pre, t: (xc.base + xc.dtsO[k]) / tsOut });
            }
            items.push(list);
        }
        vS.n = vS.dur.length;
        var aS = null;
        if (A) {
            aS = { n: A.frames.length, dur: [], size: [], sync: [], cts: [], anyCts: false, anyNonSync: false };
            A.frames.forEach(function (f) {
                aS.dur.push(A.nom); aS.size.push(f.len); aS.sync.push(true); aS.cts.push(0);
                items[f.clip].push({ track: 1, src: f.silence ? null : f.src, at: f.at, len: f.len, silence: !!f.silence, t: (f.at0 - A0) / aTs });
            });
        }

        // ── emission order: each clip on its own, clip after clip ──
        // A clip whose picture and sound come from ONE source, with no silence, goes
        // out in that source's own order — its interleave kept, its mdat one or a few
        // slices. Anything mixed is interleaved by time in ≤1 s runs per track.
        var order = [];
        items.forEach(function (list) {
            var one = list.length && list[0].src != null, s0 = list.length ? list[0].src : null;
            for (var i = 0; i < list.length && one; i++) if (list[i].silence || list[i].src !== s0) one = false;
            if (one) { list.sort(function (a, b) { return a.at - b.at; }); for (var li = 0; li < list.length; li++) order.push(list[li]); return; }
            var runs = [[], []];
            [0, 1].forEach(function (tr) {
                var cur = null;
                list.forEach(function (it) {
                    if (it.track !== tr) return;
                    if (!cur || it.t - cur.t0 >= 1) { cur = { t0: it.t, tr: tr, items: [] }; runs[tr].push(cur); }
                    cur.items.push(it);
                });
            });
            var all = runs[0].concat(runs[1]).sort(function (a, b) { return a.t0 - b.t0 || a.tr - b.tr; });
            all.forEach(function (run) { for (var ri = 0; ri < run.items.length; ri++) order.push(run.items[ri]); });
        });

        // ── chunks (stsc/co64) = consecutive same-track samples in the output ──
        var outV = { trak: first.track.trak, tkhd: first.track.tkhd, mdia: first.track.mdia, mdhd: first.track.mdhd, minf: first.track.minf, stbl: first.track.stbl,
                     B: first.init.bytes, id: 1, idOut: 1, mediaTs: tsOut, writeTs: tsOut !== first.track.mediaTs, handler: 'vide', samples: vS, chunks: [], cleanTrak: true,
                     editsOut: D > 0 ? [{ segDur: Math.round(totalV / tsOut * movieTs), mediaTime: D, rate: 1 }] : null,
                     movieDurOut: Math.round(totalV / tsOut * movieTs) };
        var outTracks = [outV];
        if (A) {
            // The sound is presented from its first clip's priming to the end of the
            // picture — the edit is what trims the last frame, never a short stts entry.
            var presA = Math.max(0, A.pres), segA = Math.round(presA / aTs * movieTs);
            var outA = { trak: refA.t.trak, tkhd: refA.t.tkhd, mdia: refA.t.mdia, mdhd: refA.t.mdhd, minf: refA.t.minf, stbl: refA.t.stbl,
                         B: refA.init.bytes, id: 2, idOut: 2, mediaTs: aTs, handler: 'soun', samples: aS, chunks: [], cleanTrak: true,
                         editsOut: [{ segDur: segA, mediaTime: A0, rate: 1 }], movieDurOut: segA };
            outTracks.push(outA);
        }
        function place(baseOff) {
            var pos = baseOff, last = -1, ch = null;
            outTracks.forEach(function (o) { o.chunks = []; });
            for (var e = 0; e < order.length; e++) {
                var it = order[e], sz = it.len + (it.prefix ? it.prefix.length : 0);
                if (ch && it.track === last) ch.count++;
                else { ch = { offset: pos, count: 1, descIdx: 1 }; outTracks[it.track].chunks.push(ch); last = it.track; }
                pos += sz;
            }
            return pos - baseOff;
        }
        var mdatBytes = place(0);
        var mdatHdrLen = (mdatBytes + 8 > 0xffffffff) ? 16 : 8;
        var hasAvc = /^avc/.test(refV.type);
        var ftyp = concatFtyp(opts.brand, hasAvc);
        var mo = { tracks: outTracks, nextTrackId: outTracks.length + 1 };
        var firstMoov = buildMoov(movieInit, mo);
        var headLen = ftyp.length + firstMoov.moov.length + mdatHdrLen;
        place(headLen);
        var built = buildMoov(movieInit, mo);
        if (built.moov.length !== firstMoov.moov.length) return no('moov-size-drift');
        var mdatHeader = new Uint8Array(mdatHdrLen);
        if (mdatHdrLen === 16) { putU32(mdatHeader, 0, 1); putU64(mdatHeader, 8, mdatBytes + 16); } else putU32(mdatHeader, 0, mdatBytes + 8);
        mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74;

        // ── the mdat body: source slices, merged where contiguous; silence runs as one buffer ──
        var parts = [], silRun = 0;
        function flushSil() {
            if (!silRun) return;
            var b = new Uint8Array(silRun * sil.bytes.length);
            for (var q = 0; q < silRun; q++) b.set(sil.bytes, q * sil.bytes.length);
            parts.push({ bytes: b }); silRun = 0;
        }
        for (var e2 = 0; e2 < order.length; e2++) {
            var it2 = order[e2];
            if (it2.silence) { silRun++; continue; }
            flushSil();
            if (it2.prefix) parts.push({ bytes: it2.prefix });
            var lp = parts[parts.length - 1];
            if (lp && !lp.bytes && lp.src === it2.src && lp.at + lp.len === it2.at) lp.len += it2.len;
            else parts.push({ src: it2.src, at: it2.at, len: it2.len });
        }
        flushSil();

        return {
            ok: true, ftyp: ftyp, moov: built.moov, mdatHeader: mdatHeader, parts: parts,
            size: headLen + mdatBytes, durationMs: Math.round(totalV / tsOut * 1000),
            clips: V.map(function (xx, i) { return { startMs: Math.round(xx.base / tsOut * 1000), durMs: Math.round(xx.endO / tsOut * 1000), audioErrMs: A ? Math.round((A.clipErr[i] || 0) * 10) / 10 : 0 }; }),
            audio: A ? { frames: A.frames.length, dropped: A.stat.dropped, padded: A.stat.padded, skipped: A.stat.skipped, maxErrMs: Math.round(A.stat.maxErr * 10) / 10 } : null,
            injected: injected, videoTimescale: tsOut
        };
    }
    function concatFtyp(brand, hasAvc) {
        var w = new Writer();
        if (brand === 'mov') w.box('ftyp', function () { this.ascii('qt  '); this.u32(0x200); this.ascii('qt  '); });
        else w.box('ftyp', function () { this.ascii('isom'); this.u32(0x200); this.ascii('isom'); this.ascii('iso2'); if (hasAvc) this.ascii('avc1'); this.ascii('mp41'); });
        return w.result();
    }
    // Convenience for tests: join byte arrays in memory with a plan. `sources[i]` is the
    // Uint8Array a clip's `src: i` names.
    function concatBytes(sources, clips, opts) {
        var p = concatPlan(clips, opts);
        if (!p.ok) return p;
        var out = new Uint8Array(p.size), pos = 0;
        out.set(p.ftyp, pos); pos += p.ftyp.length;
        out.set(p.moov, pos); pos += p.moov.length;
        out.set(p.mdatHeader, pos); pos += p.mdatHeader.length;
        p.parts.forEach(function (pt) {
            var b = pt.bytes || sources[pt.src].subarray(pt.at, pt.at + pt.len);
            out.set(b, pos); pos += b.length;
        });
        p.bytes = out;
        return p;
    }

    // Convenience for tests and for in-memory blobs: apply a plan to a byte array copy.
    async function flattenBytes(u8) {
        var p = await plan(function (o, n) { return Promise.resolve(u8.subarray(o, o + n)); }, u8.length);
        if (!p.ok) return p;
        var out = new Uint8Array(p.truncateTo + p.moov.length);
        out.set(u8.subarray(0, p.truncateTo));
        p.patches.forEach(function (pt) { out.set(pt.bytes, pt.at); });
        out.set(p.moov, p.truncateTo);
        p.bytes = out;
        return p;
    }
    // Convenience for tests: cut a flat file held in memory into a new byte array.
    function cutBytes(u8, startSec, endSec, opts) {
        var layout = topLevel(u8);
        var moov = null; for (var i = 0; i < layout.length; i++) if (layout[i].type === 'moov') { moov = layout[i]; break; }
        if (!moov) return { ok: false, reason: 'no-moov' };
        var p = cutPlan(readFlat(u8.subarray(moov.start, moov.start + moov.size)), startSec, endSec, opts);
        if (!p.ok) return p;
        var out = new Uint8Array(p.size), pos = 0;
        out.set(p.ftyp, pos); pos += p.ftyp.length;
        out.set(p.moov, pos); pos += p.moov.length;
        out.set(p.mdatHeader, pos); pos += p.mdatHeader.length;
        p.parts.forEach(function (pt) { out.set(u8.subarray(pt.at, pt.at + pt.len), pos); pos += pt.len; });
        p.bytes = out;
        return p;
    }
    // Top-level boxes of a byte array (tests / small files); files go through the caller's walker.
    function topLevel(u8) {
        var out = [], off = 0, guard = 0;
        while (off + 8 <= u8.length && guard++ < MAX_TOP_LEVEL_BOXES) {
            var size = u32(u8, off), type = str4(u8, off + 4), hdr = 8;
            if (size === 1) { size = u64(u8, off + 8); hdr = 16; } else if (size === 0) size = u8.length - off;
            if (size < hdr) break;
            out.push({ type: type, start: off, size: size, hdr: hdr });
            off += size;
        }
        return out;
    }

    var api = { plan: plan, flattenBytes: flattenBytes, readFlat: readFlat, cutPlan: cutPlan, cutBytes: cutBytes, topLevel: topLevel, _parseChildren: parseChildren,
                concatPlan: concatPlan, concatBytes: concatBytes, sampleEntryOf: sampleEntryOf,
                // The one moov writer, for a caller that builds the track model itself
                // from what the camera left in the mdat (gopro-sos.js: no moov to read).
                buildMoov: buildMoov };
    root.Mp4Flatten = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
