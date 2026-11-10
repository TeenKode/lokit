/**
 * Mp4CopyTrim — a lossless (`-c copy`) cut of a flat mp4 / mov / m4v file, done
 * as bookkeeping: read the moov, plan the cut (Mp4Flatten.cutPlan), hand back a
 * File whose body is the source's own byte ranges. No demuxer stream, no re-mux,
 * not one sample byte copied, no memory ceiling — a 5 GB take trims in the time
 * it takes to read its moov, and the output is a moov-first flat MP4.
 *
 * What it replaces (mp4box-trim.js, 2026-05 → 2026-09-17): a cut that streamed
 * the whole file through mp4box.js in 4 MB chunks and re-muxed it sample by
 * sample. On a moov-at-end file — every screen recording, every ffmpeg output
 * without +faststart — it followed the demuxer's «skip past this mdat» hints,
 * never fed the bytes it skipped, and extraction stopped at the first hole:
 * 3–6 s of a 55 s cut, or a 1.2 KB file with no samples when the start lay past
 * the first chunk, delivered as «done». Prod, RU, 30 days to 2026-09-16: 137 of
 * 186 trims of sub-64 MB takes were truncated or empty; above 64 MB the tail
 * scan failed on the flattened layout («no moov found») or the in-memory
 * output buffer did («empty output buffer»). Report of 2026-09-16: three takes,
 * three 4-second files, «ЗАЧЕМ???».
 *
 * API — window.Mp4CopyTrim (window.MP4BoxTrim is the same object: the name both
 * callers and every stand have used since 2026-05):
 *   run(file, startSec, endSec, opts?) → Promise<File>
 *       opts.moovAt — byte offset of the moov when the caller knows it (the
 *       recorder does: its flatten plan appended the moov there); a wrong hint
 *       falls back to the walk. The File carries `trimInfo`
 *       {startMs, endMs, durationMs, parts, size}: the presented window, whose
 *       start is the keyframe the cut opens on — or, with opts.exact, startSec
 *       itself: the samples still open on that keyframe and an edit list hides
 *       the frames before startSec, as FFmpeg's `-ss … -c copy` does (a player
 *       that ignores edit lists shows them, on FFmpeg's file too).
 *       A fragmented source (a take whose flatten failed, an fMP4 upload) is cut
 *       from its flatten PLAN: the plan's moov points at the samples where they
 *       lie, so the parts are the file's own byte ranges at any size
 *       (trimInfo.fromFragments); a plan that fails throws 'fragmented' and the
 *       caller's other lane takes it.
 *       Throws an Error with `code`: 'not-mp4-family' | 'no-moov' | 'fragmented'
 *       | 'empty-range' | 'no-samples' | 'no-samples-in-range' | 'bad-tables'
 *       | 'short-track' (a video/sound track would cover less of the window than
 *       it does in the source — a misread table; the caller takes its other lane).
 *   keyframeTimes(file, opts?) → Promise<number[]>
 *       video sync-sample presentation times in seconds; [] when unknown.
 *   inspect(file, opts?) → Promise<{moovAt, fragmented, durationMs, tracks}>
 *   concat(spec) → Promise<File>
 *       a lossless JOIN of several mp4-family files by the same bookkeeping
 *       (Mp4Flatten.concatPlan): the output is the clips' own byte ranges plus a
 *       new moov, so its size is bounded by the disk, not by memory. See the
 *       comment above concat() for the spec and the refusals.
 *   isMp4Family(file)
 *
 * Callers: /screen-recorder inline trim (a flattened OPFS take, moov last),
 * pre-trim-modal.js (any upload; a fragmented file throws and the modal takes
 * its FFmpeg `-c copy` lane) and /video-merge's copy join (vmJoinZeroCopy).
 */
(function () {
'use strict';
if (window.Mp4CopyTrim) return;

var HEADER_WINDOW = 64 * 1024;          // one read covers the small boxes that sit together
var MAX_TOP_LEVEL_BOXES = 2000000;

function isMp4Family(file) {
    var n = (file && file.name || '').toLowerCase();
    if (/\.(mp4|m4v|m4a|mov|3gp|3g2)$/.test(n)) return true;
    if (file && file.type) {
        var t = file.type.toLowerCase();
        if (t === 'video/mp4' || t === 'video/quicktime' || t.indexOf('mp4') !== -1) return true;
    }
    return false;
}

function typed(code, msg) { var e = new Error('mp4-copy-trim: ' + (msg || code)); e.code = code; return e; }
function str4(u8, o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
function u32(u8, o) { return ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]; }
function u64(u8, o) { return u32(u8, o) * 4294967296 + u32(u8, o + 4); }

async function readBytes(file, at, len) {
    return new Uint8Array(await file.slice(at, at + len).arrayBuffer());
}

// Mp4Flatten is the model (reader + moov writer + plans). The recorder page has
// it as a versioned worker URL; every other page gets it through __jsSrc so a
// returning visitor is never pinned to last year's copy by the immutable cache.
var flattenLoading = null;
function ensureFlatten() {
    if (window.Mp4Flatten) return Promise.resolve(window.Mp4Flatten);
    if (flattenLoading) return flattenLoading;
    var url = (window.__srWorkerBase && window.__srWorkerBase.mp4Flatten)
        || (typeof window.__jsSrc === 'function' ? window.__jsSrc('/js/mp4-flatten.js') : '/js/mp4-flatten.js');
    flattenLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        var n = document.querySelector('script[nonce]');
        if (n && n.nonce) s.setAttribute('nonce', n.nonce);
        s.src = url;
        s.onload = function () { if (window.Mp4Flatten) resolve(window.Mp4Flatten); else reject(typed('no-model', 'mp4-flatten.js loaded without Mp4Flatten')); };
        s.onerror = function () { flattenLoading = null; reject(typed('no-model', 'mp4-flatten.js failed to load')); };
        document.head.appendChild(s);
    });
    return flattenLoading;
}

/**
 * Top-level layout by headers only. A box's size tells where the next one
 * starts, so an mdat is skipped, never read; the small boxes that sit together
 * (the flattened take's free/mdat pairs, ffmpeg's ftyp/free) come out of one
 * 64 KB read. A caller's `moovAt` hint short-circuits the walk when it holds.
 */
async function walk(file, opts) {
    var size = file.size, boxes = [], moov = null, hasMoof = false, ftyp = null;
    var hint = opts && opts.moovAt;
    if (typeof hint === 'number' && hint >= 0 && hint + 8 <= size) {
        var hh = await readBytes(file, hint, Math.min(16, size - hint));
        if (hh.length >= 8 && str4(hh, 4) === 'moov') {
            var hs = u32(hh, 0), hhdr = 8;
            if (hs === 1 && hh.length >= 16) { hs = u64(hh, 8); hhdr = 16; } else if (hs === 0) hs = size - hint;
            if (hs >= hhdr && hint + hs <= size) {
                var fh = await readBytes(file, 0, Math.min(16, size));
                if (fh.length >= 8 && str4(fh, 4) === 'ftyp') ftyp = { start: 0, size: u32(fh, 0) };
                return { boxes: null, moov: { start: hint, size: hs, hdr: hhdr }, ftyp: ftyp, hasMoof: false, hinted: true };
            }
        }
    }
    var off = 0, win = null, winStart = 0, guard = 0;
    while (off + 8 <= size && guard++ < MAX_TOP_LEVEL_BOXES) {
        if (!win || off < winStart || off + 16 > winStart + win.length) {
            winStart = off; win = await readBytes(file, off, Math.min(HEADER_WINDOW, size - off));
            if (win.length < 8) break;
        }
        var p = off - winStart;
        var bsize = u32(win, p), type = str4(win, p + 4), hdr = 8;
        if (bsize === 1) { if (p + 16 > win.length) break; bsize = u64(win, p + 8); hdr = 16; }
        else if (bsize === 0) bsize = size - off;
        if (bsize < hdr) break;                                  // corrupt: keep what was read so far
        var b = { type: type, start: off, size: bsize, hdr: hdr };
        boxes.push(b);
        if (type === 'moov' && off + bsize <= size) moov = b;   // a second moov (fMP4 init + flat) — the last complete one is the flat one
        // fragmented: the flatten plan walks the file itself, nothing more to learn here
        else if (type === 'moof') { hasMoof = true; break; }
        else if (type === 'ftyp' && !ftyp) ftyp = b;
        off += bsize;
    }
    return { boxes: boxes, moov: moov, ftyp: ftyp, hasMoof: hasMoof, hinted: false };
}

async function readModel(file, opts) {
    var M = await ensureFlatten();
    var lay = await walk(file, opts);
    if (lay.hasMoof) return await flattenedModel(file, M, lay);
    if (!lay.moov) throw typed('no-moov', 'no moov box');
    var moovBytes = await readBytes(file, lay.moov.start, lay.moov.size);
    var init;
    try { init = M.readFlat(moovBytes); }
    catch (e) { throw typed('bad-tables', e && e.message); }
    return { M: M, layout: lay, init: init };
}

// fMP4 → the same tables, from the flatten PLAN read straight off the file. The
// flatten is in place: its moov points at the sample bytes where they already
// lie, so the cut's parts are byte ranges of the file itself — any size, nothing
// copied. Until 30.10.2026 the file was flattened as a copy in memory and refused
// above 256 MiB: a 381 MB screen take whose flatten had failed «could not be
// trimmed» (RU, 30 d: 2 of 2 such trims). The plan asks for headers and moofs
// only, but a Blob read costs ~2 ms whatever its size, so they are served from
// 4 MB windows (the file is read once, 4 MB held). Measured on a 330 MB take of
// 880 fragments: 32 KB windows 1.9 s (881 reads), 1 MB 1.4 s, 4 MB 0.8 s (81),
// the whole file in memory 0.58 s.
function windowedReader(file) {
    var win = null, winAt = 0, WIN = 4 * 1024 * 1024;
    return async function (at, len) {
        if (!win || at < winAt || at + len > winAt + win.length) {
            winAt = at;
            win = await readBytes(file, at, Math.min(Math.max(len, WIN), file.size - at));
        }
        return win.subarray(at - winAt, at - winAt + len);
    };
}
async function flattenedModel(file, M, lay) {
    var p = await M.plan(windowedReader(file), file.size);
    if (!p.ok) throw typed('fragmented', 'fragmented mp4: flatten ' + (p.reason || 'failed'));
    var init;
    try { init = M.readFlat(p.moov); }
    catch (e) { throw typed('bad-tables', e && e.message); }
    return { M: M, layout: { moov: null, fragmented: true, hinted: false, boxes: null, ftyp: null, hasMoof: true }, init: init, fromFragments: { fragments: p.fragments, dropped: p.dropped, holes: p.holes || 0 } };
}

async function run(file, startSec, endSec, opts) {
    if (!file || !file.size) throw typed('empty-file', 'empty file');
    if (!(endSec > startSec)) throw typed('empty-range', 'empty range');
    if (!isMp4Family(file)) throw typed('not-mp4-family', 'not-mp4-family');
    var m = await readModel(file, opts);
    var plan = m.M.cutPlan(m.init, startSec, endSec, { exact: !!(opts && opts.exact) });
    // 'short-track': a picture or sound track would cover less of the window than it
    // does in the source — a misread, refused so the caller takes its other lane
    if (!plan.ok) throw typed(plan.reason || 'plan-failed', plan.reason + (plan.track ? ' ' + plan.track + ' ' + plan.gotMs + '/' + plan.wantMs + ' ms' : ''));
    var parts = [plan.ftyp, plan.moov, plan.mdatHeader];
    // the body is always the file's own bytes — a fragmented source too (its plan's moov points into it)
    for (var i = 0; i < plan.parts.length; i++) parts.push(file.slice(plan.parts[i].at, plan.parts[i].at + plan.parts[i].len));
    var newName = (file.name || 'video.mp4').replace(/(\.[^.]+)?$/, '_trim.mp4');
    var out = new File(parts, newName, { type: 'video/mp4', lastModified: Date.now() });
    out.trimInfo = { startMs: plan.startMs, endMs: plan.endMs, durationMs: plan.durationMs, parts: plan.parts.length, size: plan.size, tracks: plan.tracks, fromFragments: !!m.fromFragments };
    return out;
}

async function inspect(file, opts) {
    var m = await readModel(file, opts);
    var movieTs = m.init.movieTs || 1000, longest = 0;
    var tracks = m.init.tracks.map(function (t) {
        var total = 0; for (var i = 0; i < t.samples.n; i++) total += t.samples.dur[i];
        var ms = Math.round(total / t.mediaTs * 1000); if (ms > longest) longest = ms;
        return { id: t.id, handler: t.handler, samples: t.unit ? t.unit.frames : t.samples.n, mediaDurMs: ms, chunks: t.chunks.length, edits: t.edits };
    });
    return { moovAt: m.layout.moov ? m.layout.moov.start : -1, fragmented: !!m.fromFragments, movieTs: movieTs, durationMs: longest, tracks: tracks };
}

// Video keyframe presentation times (seconds), for a trim UI that snaps its
// start handle to where a copy cut can actually begin. Reads the moov only.
async function keyframeTimes(file, opts) {
    if (!isMp4Family(file)) return [];
    var m;
    try { m = await readModel(file, opts); } catch (_) { return []; }
    var v = null;
    for (var i = 0; i < m.init.tracks.length; i++) if (m.init.tracks[i].handler === 'vide') { v = m.init.tracks[i]; break; }
    if (!v || !v.samples.n) return [];
    var S = v.samples, po = 0, delay = 0;
    if (v.edits && v.edits.length) {
        var e0 = v.edits[0], e1 = v.edits[1];
        if (e0.mediaTime === -1 && e1 && e1.mediaTime >= 0) { delay = e0.segDur / (m.init.movieTs || 1); po = e1.mediaTime; }
        else if (e0.mediaTime >= 0) po = e0.mediaTime;
    }
    var out = [], acc = 0;
    for (var k = 0; k < S.n; k++) {
        if (S.sync[k]) out.push((acc + S.cts[k] - po) / v.mediaTs + delay);
        acc += S.dur[k];
    }
    out.sort(function (a, b) { return a - b; });
    return out;
}

/**
 * concat(spec) → Promise<File> — a lossless JOIN of mp4-family files, done the
 * same way as the cut: read each moov, plan (Mp4Flatten.concatPlan), hand back a
 * File whose body is the sources' own byte ranges. No sample byte passes through
 * JS, so there is no memory ceiling on the result — the ceiling this replaces in
 * /video-merge was FFmpeg-WASM building the whole output in its heap (0.9 GB on a
 * 4 GB laptop; report of 2026-09-25).
 *
 *   spec.clips   [{video: Blob, audio: Blob | null}] — the picture of each clip
 *                and where its sound comes from (the same Blob, a separately
 *                re-encoded .m4a, or null = silence for the clip's length);
 *   spec.silence Blob | null — a short AAC file in the output sound's format; one
 *                frame of it (past the priming) is what fills a clip without sound;
 *   spec.brand   'mp4' | 'mov';   spec.name — the File's name.
 *
 * The File carries `concatInfo` {durationMs, clips:[{startMs, durMs, audioErrMs}],
 * audio, injected, parts, size}. A refusal throws an Error whose `code` is the
 * plan's reason and `clip` the index it is about (the caller re-encodes that clip
 * and joins again), or 'no-moov' / 'fragmented' / 'bad-tables' from reading.
 */
async function concat(spec) {
    var M = await ensureFlatten();
    var models = [], blobs = [], srcs = [];
    async function modelOf(b) {
        var i = blobs.indexOf(b);
        if (i >= 0) return models[i];
        var m;
        try { m = await readModel(b); }
        catch (e) { var i2 = spec.clips.findIndex(function (c) { return c.video === b || c.audio === b; }); if (e && i2 >= 0) e.clip = i2; throw e; }
        m.src = srcs.length; srcs.push(b);
        blobs.push(b); models.push(m);
        return m;
    }
    function trackOf(m, handler) {
        for (var i = 0; i < m.init.tracks.length; i++) { var t = m.init.tracks[i]; if (t.handler === handler && t.samples.n > 0) return t; }
        return null;
    }
    var clips = [];
    for (var i = 0; i < spec.clips.length; i++) {
        var c = spec.clips[i], mv = await modelOf(c.video), vt = trackOf(mv, 'vide');
        if (!vt) { var ev = typed('no-video', 'clip ' + (i + 1) + ' has no video track'); ev.clip = i; throw ev; }
        var entry = { video: { init: mv.init, track: vt, src: mv.src }, audio: null };
        if (c.audio) {
            var ma = await modelOf(c.audio), at = trackOf(ma, 'soun');
            if (at) entry.audio = { init: ma.init, track: at, src: ma.src };
        }
        clips.push(entry);
    }
    var silence = null;
    if (spec.silence) {
        var ms = await modelOf(spec.silence), st = trackOf(ms, 'soun');
        if (st && st.samples.n) {
            // a frame past the encoder's priming: steady-state silence
            var k = Math.min(st.samples.n - 1, 3), at2 = st.chunks[0].offset, idx = 0;
            for (var ch = 0; ch < st.chunks.length && idx <= k; ch++) {
                var o = st.chunks[ch].offset;
                for (var q = 0; q < st.chunks[ch].count; q++, idx++) { if (idx === k) at2 = o; o += st.samples.size[idx]; }
            }
            var src = srcs[ms.src], len = st.samples.size[k];
            var bytes = src instanceof Uint8Array ? src.slice(at2, at2 + len) : await readBytes(src, at2, len);
            var se = M.sampleEntryOf(ms.init, st);
            silence = { bytes: bytes, dur: st.samples.dur[k], asc: se && se.asc };
        }
    }
    var plan = M.concatPlan(clips, { silence: silence, brand: spec.brand === 'mov' ? 'mov' : 'mp4' });
    if (!plan.ok) { var e = typed(plan.reason || 'plan-failed', plan.reason + (plan.clip >= 0 ? ' (clip ' + (plan.clip + 1) + ')' : '')); e.clip = plan.clip; throw e; }
    var parts = [plan.ftyp, plan.moov, plan.mdatHeader];
    for (var p = 0; p < plan.parts.length; p++) {
        var pt = plan.parts[p];
        if (pt.bytes) { parts.push(pt.bytes); continue; }
        var s = srcs[pt.src];
        parts.push(s instanceof Uint8Array ? s.subarray(pt.at, pt.at + pt.len) : s.slice(pt.at, pt.at + pt.len));
    }
    var type = spec.brand === 'mov' ? 'video/quicktime' : 'video/mp4';
    var out = new File(parts, spec.name || ('merged.' + (spec.brand === 'mov' ? 'mov' : 'mp4')), { type: type, lastModified: Date.now() });
    if (out.size !== plan.size) throw typed('size-mismatch', 'assembled ' + out.size + ' B, planned ' + plan.size);
    out.concatInfo = { durationMs: plan.durationMs, clips: plan.clips, audio: plan.audio, injected: plan.injected, parts: plan.parts.length, size: plan.size, videoTimescale: plan.videoTimescale };
    return out;
}

window.Mp4CopyTrim = { run: run, keyframeTimes: keyframeTimes, inspect: inspect, isMp4Family: isMp4Family, concat: concat };
window.MP4BoxTrim = window.Mp4CopyTrim;   // the historical name — every caller and stand still says it

})();
