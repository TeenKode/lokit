/**
 * mp4-track-remux.js — drop (or keep) whole tracks of an mp4-family file
 * WITHOUT moving a single sample byte through JS.
 *
 * Why this module exists
 * ----------------------
 * Muting a video is metadata surgery: delete the audio `trak` from `moov`,
 * repoint the video chunk offsets, done. We were doing it with FFmpeg WASM
 * `-c:v copy -an`, which is correct but pays for the whole file three times:
 *   1. every byte is pulled out of the File through WORKERFS into the wasm heap,
 *   2. the whole OUTPUT is materialised inside that same 32-bit heap,
 *   3. `readFile()` copies it out again into a JS Uint8Array before the Blob.
 * Measured on a 902 MB / 6 min 1080p mp4, desktop Chromium, single-thread wasm
 * (no SharedArrayBuffer — that is what an anonymous visitor gets, see
 * SecurityHeaders.php): 28 s warm / 58 s cold for an operation native ffmpeg
 * finishes in 1.35 s. Bug report 2026-08-21 (887 MB mp4, Android phone):
 * "30 minutes, progress about 2%".
 *
 * The wasm path is not slow because of codec work — there is none. It is slow
 * because it shovels ~1.8 GB across the JS/wasm boundary. So don't shovel:
 * build the output as a Blob whose parts are `file.slice()` REFERENCES. The
 * browser keeps those as file-backed handles — measured on the same 902 MB
 * file: a 1000-part Blob costs 250 ms and 0 MB of JS heap, and streaming the
 * finished 860 MB blob out to disk costs 3.3 s.
 *
 * What it rewrites, and nothing else
 * ----------------------------------
 * The new `moov` is the ORIGINAL moov with whole `trak` boxes spliced out by
 * byte range — every other box (mvhd, udta, unknown vendor boxes, per-track
 * edts/tapt/whatever) is copied verbatim. The only integers touched are the
 * `moov` box size and the `stco`/`co64` chunk offsets. Nothing is
 * re-serialised from a parsed model, so there is no class of "box we parsed
 * imperfectly and wrote back wrong". One box may change FORM: a 32-bit `stco`
 * whose chunks land past 4 GiB in the new layout becomes a `co64` (see
 * «Chunk offsets past 4 GiB»), and only the four headers above it change.
 * replaceAudio patches two more fields of a picture track in place — its
 * composition offsets and edit media_time, same sizes — so the B-frame delay
 * plays on Windows too (see «The picture's B-frame delay»).
 *
 * Durability
 * ----------
 * The zero-copy promise — a Blob of file.slice() references — is only as
 * durable as the File behind it. On Android the OS revokes picker handles
 * within minutes, and iOS's Photos picker hands out a temporary transcode:
 * reading the moov, and later reading the output Blob, then fails with a
 * DOMException that has no remuxReason and was logged as a bare «error»
 * (mute-video: 104 runs / 74 sessions in 30 days; the /video-volume lane's
 * first field week, 13.09.2026, Android 10 / Chrome 152 — the FFmpeg
 * fallback then succeeded only because _withMounts rescues from the same
 * cache). So both entry points hand the input to FileBytes.settle() when
 * that primitive is on the page: it returns the durable copy the uploader
 * already made (RAM below the cap, OPFS above) without starting a read, or
 * the live file when there is none. `durable` in the result says which.
 *
 * API
 * ---
 *   MP4TrackRemux.looksSupported(file) -> bool          (cheap name/type test)
 *   MP4TrackRemux.remux(file, opts)    -> Promise<{blob, tracks, ...}>
 *      opts.dropHandlers    hdlr types to remove, e.g. ['soun']
 *      opts.keepHandlers    types to keep (everything else dropped)
 *      opts.overheadBudget  max fraction of unreferenced bytes we may keep in
 *                           order to lower the Blob part count (default 0.25 —
 *                           see coalesce(), the number is measured)
 *      opts.maxParts        soft target for part count (default 2000)
 *
 * Fragmented input (mvex + moof/trun) is flattened first — see «fragmented
 * input» below; `flattened` in the result says so.
 *
 * Throws with a stable machine-readable reason so callers can fall back to
 * FFmpeg: not-mp4-family, no-moov, moov-walk-short, external-media,
 * no-tracks, no-tracks-left, nothing-to-drop, unsupported-sample-table,
 * tref-dangling, moov-too-large, offset-unmapped, fragmented-stsd,
 * fragmented-no-samples, fragmented-trex-missing, fragmented-shape,
 * fragmented-traf-shape, fragmented-moof-too-large. (`offset-overflow` is
 * no longer a property of a file — a table that would overflow is widened —
 * and is thrown only if that decision were ever wrong.)
 */
(function () {
'use strict';
if (window.MP4TrackRemux) return;

var MOOV_MAX = 96 * 1024 * 1024;   // a moov bigger than this is not a media file we made
var TOP_GUARD = 4096;              // top-level box count sanity guard

function fourcc(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
}
function u64(dv, o) {
    // Sizes/offsets above 2^53 do not exist in practice; a uint32 pair stays
    // exact up to 8 PB, which avoids BigInt plumbing through the whole module.
    return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);
}
function err(reason) { var e = new Error(reason); e.remuxReason = reason; return e; }

/* See «Durability» above. Fail-open: no FileBytes, or a settle that throws,
   means the file we were given. */
async function settled(file) {
    var FB = (typeof window !== 'undefined') ? window.FileBytes : null;
    if (!file || !FB || typeof FB.settle !== 'function') return file;
    try { var d = await FB.settle(file); return d || file; } catch (_) { return file; }
}

/* box walking ------------------------------------------------------------ */

/* Walk boxes inside a buffer. Offsets are relative to that buffer's origin. */
function walk(dv, start, end) {
    var out = [], pos = start, guard = 0;
    while (pos + 8 <= end && guard++ < 262144) {
        var size = dv.getUint32(pos);
        var type = fourcc(dv, pos + 4);
        var hdr = 8;
        if (size === 1) {
            if (pos + 16 > end) break;
            size = u64(dv, pos + 8);
            hdr = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < hdr || pos + size > end) break;
        out.push({ type: type, start: pos, size: size, hdr: hdr });
        pos += size;
    }
    return out;
}
function find(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
}

/* Top-level walk over the FILE — reads 16 bytes per box, not the boxes. */
async function topLevel(file) {
    var out = [], pos = 0, guard = 0;
    while (pos + 8 <= file.size && guard++ < TOP_GUARD) {
        var buf = await file.slice(pos, Math.min(pos + 16, file.size)).arrayBuffer();
        if (buf.byteLength < 8) break;
        var dv = new DataView(buf);
        var size = dv.getUint32(0), type = fourcc(dv, 4), hdr = 8;
        if (size === 1) {
            if (buf.byteLength < 16) break;
            size = u64(dv, 8);
            hdr = 16;
        } else if (size === 0) {
            size = file.size - pos;
        }
        if (size < hdr) break;
        out.push({ type: type, start: pos, size: size, hdr: hdr });
        pos += size;
    }
    return out;
}

/* sample table reading --------------------------------------------------- */

function readChunkOffsets(dv, box) {
    var p = box.start + box.hdr + 4;              // skip version+flags
    var n = dv.getUint32(p); p += 4;
    var wide = box.type === 'co64';
    var offs = new Float64Array(n);               // exact for values < 2^53
    for (var i = 0; i < n; i++) {
        offs[i] = wide ? u64(dv, p) : dv.getUint32(p);
        p += wide ? 8 : 4;
    }
    return { offsets: offs, base: box.start + box.hdr + 8, wide: wide, count: n };
}

function readStsc(dv, box) {
    var p = box.start + box.hdr + 4;
    var n = dv.getUint32(p); p += 4;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
        out[i] = { first: dv.getUint32(p), per: dv.getUint32(p + 4) };
        p += 12;
    }
    return out;
}

function readSampleSizes(dv, stsz, stz2) {
    var i;
    if (stsz) {
        var p = stsz.start + stsz.hdr + 4;
        var uniform = dv.getUint32(p);
        var n = dv.getUint32(p + 4);
        if (uniform) return { uniform: uniform, count: n, at: null };
        p += 8;
        var a = new Float64Array(n);
        for (i = 0; i < n; i++) { a[i] = dv.getUint32(p); p += 4; }
        return { uniform: 0, count: n, at: a };
    }
    if (stz2) {
        var q = stz2.start + stz2.hdr + 4;
        var field = dv.getUint8(q + 3);
        var cnt = dv.getUint32(q + 4);
        q += 8;
        var b = new Float64Array(cnt);
        if (field === 16)      { for (i = 0; i < cnt; i++) { b[i] = dv.getUint16(q); q += 2; } }
        else if (field === 8)  { for (i = 0; i < cnt; i++) { b[i] = dv.getUint8(q); q += 1; } }
        else if (field === 4)  { for (i = 0; i < cnt; i++) { var by = dv.getUint8(q + (i >> 1)); b[i] = (i & 1) ? (by & 15) : (by >> 4); } }
        else throw err('unsupported-sample-table');
        return { uniform: 0, count: cnt, at: b };
    }
    throw err('unsupported-sample-table');
}

/* Byte length of every chunk, from stsc + sample sizes. */
function chunkLengths(chunkCount, stsc, sizes) {
    var lens = new Float64Array(chunkCount);
    var sample = 0, e = 0;
    for (var c = 0; c < chunkCount; c++) {
        while (e + 1 < stsc.length && stsc[e + 1].first <= c + 1) e++;
        var per = stsc.length ? stsc[e].per : 0;
        var total = 0;
        if (sizes.uniform) {
            total = per * sizes.uniform;
            sample += per;
        } else {
            for (var k = 0; k < per; k++) {
                if (sample >= sizes.count) break;
                total += sizes.at[sample++];
            }
        }
        lens[c] = total;
    }
    return lens;
}

/* track description ------------------------------------------------------ */

function describeTrak(dv, trak) {
    var kids = walk(dv, trak.start + trak.hdr, trak.start + trak.size);
    var tkhd = find(kids, 'tkhd');
    var mdia = find(kids, 'mdia');
    var tref = find(kids, 'tref');
    var t = { box: trak, handler: '', id: 0, refIds: [] };

    if (tkhd) {
        var ver = dv.getUint8(tkhd.start + tkhd.hdr);
        // v1: creation(8) modification(8) track_id(4);  v0: 4 + 4 + 4
        t.id = ver === 1 ? dv.getUint32(tkhd.start + tkhd.hdr + 4 + 16)
                         : dv.getUint32(tkhd.start + tkhd.hdr + 4 + 8);
    }
    if (tref) {
        var refs = walk(dv, tref.start + tref.hdr, tref.start + tref.size);
        for (var r = 0; r < refs.length; r++) {
            var n = (refs[r].size - refs[r].hdr) >> 2;
            for (var q = 0; q < n; q++) t.refIds.push(dv.getUint32(refs[r].start + refs[r].hdr + q * 4));
        }
    }
    if (!mdia) return t;
    var mk = walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size);
    var hdlr = find(mk, 'hdlr');
    if (hdlr) t.handler = fourcc(dv, hdlr.start + hdlr.hdr + 8);
    var minf = find(mk, 'minf');
    if (!minf) return t;
    var nk = walk(dv, minf.start + minf.hdr, minf.start + minf.size);

    var dinf = find(nk, 'dinf');
    if (dinf) {
        var dref = find(walk(dv, dinf.start + dinf.hdr, dinf.start + dinf.size), 'dref');
        if (dref) {
            var entries = walk(dv, dref.start + dref.hdr + 8, dref.start + dref.size);
            for (var d = 0; d < entries.length; d++) {
                // self-contained flag is bit 0 of the entry's version+flags word
                if (!(dv.getUint32(entries[d].start + entries[d].hdr) & 1)) t.external = true;
            }
        }
    }

    var stbl = find(nk, 'stbl');
    if (!stbl) return t;
    var sk = walk(dv, stbl.start + stbl.hdr, stbl.start + stbl.size);
    t.stbl = {
        stco: find(sk, 'stco') || find(sk, 'co64'),
        stsc: find(sk, 'stsc'),
        stsz: find(sk, 'stsz'),
        stz2: find(sk, 'stz2'),
        stsd: find(sk, 'stsd')          // codec fourcc + geometry, for inspect()
    };
    return t;
}

/* range set -------------------------------------------------------------- */

/* Sort + merge overlapping/touching ranges, then keep merging across the
   SMALLEST gaps first until we are under the part budget — but never spend
   more than `overheadBudget` of the payload on bytes nobody references.
   Both knobs matter: a part costs main-thread time, an unreferenced byte
   costs download size.

   Measured in Chromium on a 912 MB file (58 026 parts): file.slice() 8.0 s,
   Blob() 1.7 s — ~0.17 ms per part, and slice() is the bigger half, so
   batching the parts into nested Blobs does not help (tried: 8.5-10 s, worse
   than flat). 2 000 parts is 0.34 s here and roughly a second on a phone.

   The budget is what decides whether we can REACH that ceiling, and its first
   value (2 %) was too tight: in a file whose muxer writes one chunk per frame
   the gaps are single audio samples spread evenly through the whole mdat, so
   buying the merges costs about the size of the audio track. At 2 % the merge
   stopped at 58 026 parts and the mute took 22.6 s — the very failure this
   module exists to remove. 25 % lets that case through (it needs 6.6 %) while
   still refusing the shape the cap is really for: a small video carrying a
   huge PCM track, where keeping the dropped bytes would bloat the output
   several-fold. When the budget does bind we accept the extra parts and the
   extra seconds, because a file many times larger than it should be is the
   worse outcome; `parts` and `waste` both ride along in the lane telemetry. */
function coalesce(ranges, maxParts, overheadBudget) {
    ranges.sort(function (a, b) { return a.start - b.start; });
    var merged = [], i;
    for (i = 0; i < ranges.length; i++) {
        var last = merged[merged.length - 1];
        if (last && ranges[i].start <= last.end) {
            if (ranges[i].end > last.end) last.end = ranges[i].end;
        } else {
            merged.push({ start: ranges[i].start, end: ranges[i].end });
        }
    }
    var payload = 0;
    for (i = 0; i < merged.length; i++) payload += merged[i].end - merged[i].start;
    if (merged.length <= maxParts) return { ranges: merged, waste: 0 };

    var gaps = [];
    for (i = 1; i < merged.length; i++) gaps.push({ i: i, g: merged[i].start - merged[i - 1].end });
    gaps.sort(function (a, b) { return a.g - b.g; });

    var budget = payload * overheadBudget;
    var joinAt = {}, spent = 0, need = merged.length - maxParts;
    for (i = 0; i < gaps.length && need > 0; i++) {
        if (spent + gaps[i].g > budget) break;
        spent += gaps[i].g;
        joinAt[gaps[i].i] = 1;
        need--;
    }
    if (!spent) return { ranges: merged, waste: 0 };

    var out = [{ start: merged[0].start, end: merged[0].end }];
    for (i = 1; i < merged.length; i++) {
        if (joinAt[i]) out[out.length - 1].end = merged[i].end;
        else out.push({ start: merged[i].start, end: merged[i].end });
    }
    return { ranges: out, waste: spent };
}

/* main ------------------------------------------------------------------- */

/* Tracks that only DESCRIBE what is being removed go with it ---------------
 *
 * An iPhone video with Spatial Audio (iPhone 16 and later, iOS 18+) carries two
 * soundtracks — AAC stereo for compatibility and the 4-channel APAC sound
 * field — plus «Core Media Metadata» tracks (`mebx`). A metadata track names
 * the track it is about in its track reference (`tref`, ISO/IEC 14496-12
 * §8.3.3; `cdsc` = «this track describes that one»), and the one about the
 * spatial sound points at a soundtrack. Removing the sound left that reference
 * pointing at nothing, and both builders refused the file `tref-dangling`:
 * RU, 30 days to 02.10.2026 — 126 refusals in 88 sessions, 94 % .mov, 79 % iOS
 * 18.7/26 (Safari, Yandex), median 53 MB, up to 9 GB (/mute-video 50 sessions,
 * /add-music-to-video 34, /video-volume 4, /profanity-remover-video 1). Every
 * one fell back to FFmpeg — minutes instead of a second on the phone, and no
 * way at all past the MEMFS wall.
 *
 * A track that describes a removed track describes nothing, so it is removed
 * too — and so is anything that describes IT (the closure). The result is
 * still a superset of what the FFmpeg fallback keeps (it maps no data tracks
 * at all), and nothing is rewritten: a track either goes whole or stays
 * byte for byte. A picture track is never removed this way — a `vide` trak
 * that itself references a removed track keeps the refusal. Returns the
 * handlers of the tracks it moved from `keep` to `drop`. */
function dropDescribers(keep, drop) {
    var gone = {}, moved = [], again = true, i, r;
    for (i = 0; i < drop.length; i++) gone[drop[i].id] = 1;
    while (again) {
        again = false;
        for (i = keep.length - 1; i >= 0; i--) {
            var t = keep[i];
            if (t.handler === 'vide') continue;
            for (r = 0; r < t.refIds.length; r++) {
                if (!gone[t.refIds[r]]) continue;
                keep.splice(i, 1);
                drop.push(t);
                gone[t.id] = 1;
                moved.push(t.handler || '?');
                again = true;
                break;
            }
        }
    }
    return moved;
}

function looksSupported(file) {
    if (!file || !file.size) return false;
    var n = (file.name || '').toLowerCase();
    if (/\.(mp4|m4v|m4a|m4b|mov|3gp|3g2)$/.test(n)) return true;
    var t = (file.type || '').toLowerCase();
    return t === 'video/mp4' || t === 'video/quicktime' || t === 'audio/mp4' || t.indexOf('mp4') !== -1;
}

async function remux(file, opts) {
    opts = opts || {};
    var clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
    var t0 = clock.now();
    if (!looksSupported(file)) throw err('not-mp4-family');
    var given = file;
    file = await settled(file);
    var V = await loadMoov(file);
    var i;

    var dropSet = opts.dropHandlers || null;
    var keepSet = opts.keepHandlers || null;
    // keepTrackIds (tkhd track_ID) wins over the handler lists: a caller that
    // has chosen ONE sound track — the AAC next to an iPhone `apac`, the first
    // of two languages — must not get the others back as passengers.
    var keepIds = (opts.keepTrackIds && opts.keepTrackIds.length) ? opts.keepTrackIds : null;
    var keep = [], drop = [];
    for (i = 0; i < V.traks.length; i++) {
        var h = V.traks[i].handler;
        var kill = keepIds ? keepIds.indexOf(V.traks[i].id) === -1
                 : dropSet ? dropSet.indexOf(h) !== -1
                           : (keepSet ? keepSet.indexOf(h) === -1 : false);
        (kill ? drop : keep).push(V.traks[i]);
    }
    if (!drop.length) throw err('nothing-to-drop');
    var described = dropDescribers(keep, drop);
    if (!keep.length) throw err('no-tracks-left');

    var droppedIds = {}, dropAt = {};
    for (i = 0; i < drop.length; i++) { droppedIds[drop[i].id] = 1; dropAt[drop[i].box.start] = 1; }
    var src = new Uint8Array(V.buf), entries = [], keepAt = {};
    for (i = 0; i < keep.length; i++) {
        var e = trakEntry(src.subarray(keep[i].box.start, keep[i].box.start + keep[i].box.size), file);
        for (var r = 0; r < keep[i].refIds.length; r++) {
            if (droppedIds[keep[i].refIds[r]]) throw err('tref-dangling');
        }
        entries.push(e);
        keepAt[keep[i].box.start] = e;
    }
    if (!entries.some(function (x) { return x.ranges.length > 0; })) throw err('unsupported-sample-table');

    /* New moov = old moov minus the dropped traks; everything else verbatim. */
    var pieces = [];
    for (i = 0; i < V.kids.length; i++) {
        var k = V.kids[i];
        if (dropAt[k.start]) continue;
        pieces.push(keepAt[k.start] ? { trak: keepAt[k.start] } : { bytes: src.subarray(k.start, k.start + k.size) });
    }
    var ftyp = V.ftypBox ? file.slice(V.ftypBox.start, V.ftypBox.start + V.ftypBox.size) : null;
    var ftypLen = V.ftypBox ? V.ftypBox.size : 0;
    /* opts.brand — the ftyp of an AUDIO file made from a video. The source's
       own brand leaks otherwise, and players read it: a sound track out of a
       .3gp kept `3gp6` and Firefox refused the .m4a outright; ALAC under `isom`
       did not open in Media Foundation (measured 2026-10-08). Only an ISO-family
       source is relabelled: a QuickTime moov stays under `qt  `, because
       AVFoundation reads the whole moov by the rules its brand names (see
       isQuickTimeMovie) and a QuickTime SoundDescription under an ISO brand is
       exactly the mismatch that silenced iPhones before. */
    if (opts.brand && V.ftypBox && !(await isQuickTimeMovie(file, V.ftypBox))) {
        ftyp = brandFtyp(opts.brand);
        ftypLen = ftyp.length;
    }
    var out = writeFile({
        ftyp: ftyp,
        ftypLen: ftypLen,
        pieces: pieces,
        groups: [{ file: file, traks: entries, maxParts: opts.maxParts || 2000 }],
        overheadBudget: typeof opts.overheadBudget === 'number' ? opts.overheadBudget : 0.25,
        mime: opts.mime || file.type || 'video/mp4'
    });
    return {
        blob: out.blob,
        ms: Math.round(clock.now() - t0),
        parts: out.parts,
        waste: out.waste,
        kept: keep.map(function (t) { return t.handler; }),
        dropped: drop.map(function (t) { return t.handler; }),
        savedBytes: file.size - out.blob.size,
        durable: file !== given,
        flattened: V.flattened,
        co64: out.widened,
        described: described              // tracks that only described the removed ones, removed with them
    };
}

/* fragmented input ------------------------------------------------------- */

/* A fragmented MP4 (mvex in moov, samples described by trun boxes inside
   moof fragments) has no flat sample tables to copy, so the zero-copy remux
   used to refuse it and the caller paid an FFmpeg `-c copy` for the whole
   file — 55 s for a 434 MB clip on an Android phone, and memory ×3 with the
   2 GiB buffer wall beyond it (/video-volume, 13.09.2026). Who writes such
   files: our own /video-loop on phones (`+frag_keyframe+empty_moov`), the
   screen recorder's OPFS stream writer (mp4-muxer `fastStart:'fragmented'`),
   DASH/HLS downloads, some cameras. mute-video, 30 days: 127 runs / 96
   sessions refused as `fragmented`.

   flattenMoov() builds a FLAT moov from the fragments: every leaf box that
   carries meaning is copied verbatim (stsd with the codec configuration,
   tkhd, mdhd, hdlr, vmhd/smhd, dinf, edts, udta…) — only the sample tables
   (stts/ctts/stss/stsz/stsc/stco or co64) are derived from the truns, the
   three durations (mvhd/tkhd/mdhd) are filled in from them (fragmented
   files carry 0 there), and mvex is dropped. Chunk offsets stay ABSOLUTE
   positions in the original file, so the sample bytes are still
   file.slice() references and nothing is copied. One chunk per trun.

   Addressing per ISO 14496-12 §8.8.7: base = tfhd.base_data_offset when
   present; else the moof start when default-base-is-moof (0x20000) or for
   the first traf; else the end of the previous traf's data. trun.data_offset
   is relative to that base; a trun without one continues where the previous
   left off. Per-sample duration/size/flags come from the trun, else tfhd
   defaults, else trex. Sync = !(flags >>> 16 & 1). Composition offsets from
   trun v1 are signed and become a ctts v1.

   Refusals (all named): fragmented-stsd (a sample_description_index other
   than 1 — a flat stsd can only carry one), fragmented-no-samples,
   fragmented-trex-missing (a traf for a track no trex describes). */
var TF_BASE_DATA_OFFSET = 0x1, TF_SAMPLE_DESC = 0x2, TF_DEF_DUR = 0x8, TF_DEF_SIZE = 0x10, TF_DEF_FLAGS = 0x20, TF_DEFAULT_BASE_IS_MOOF = 0x20000;
var TR_DATA_OFFSET = 0x1, TR_FIRST_FLAGS = 0x4, TR_DUR = 0x100, TR_SIZE = 0x200, TR_FLAGS = 0x400, TR_CTS = 0x800;

function fullBoxVersion(dv, box) { return dv.getUint8(box.start + box.hdr); }
function fullBoxFlags(dv, box) { return dv.getUint32(box.start + box.hdr) & 0xffffff; }

/* Read trex defaults out of mvex: track_ID → { sdi, dur, size, flags }. */
function readTrex(dv, mvex) {
    var out = {}, kids = walk(dv, mvex.start + mvex.hdr, mvex.start + mvex.size);
    for (var i = 0; i < kids.length; i++) {
        if (kids[i].type !== 'trex') continue;
        var p = kids[i].start + kids[i].hdr + 4;
        out[dv.getUint32(p)] = { sdi: dv.getUint32(p + 4), dur: dv.getUint32(p + 8), size: dv.getUint32(p + 12), flags: dv.getUint32(p + 16) };
    }
    return out;
}

/* Walk every moof of the file and collect per-track samples and chunks. */
async function collectFragments(file, top, trex, tracks) {
    var byId = {};
    var i;
    for (i = 0; i < tracks.length; i++) byId[tracks[i].id] = { samples: [], chunks: [] };
    for (i = 0; i < top.length; i++) {
        if (top[i].type !== 'moof') continue;
        var moof = top[i];
        if (moof.size > MOOV_MAX) throw err('fragmented-moof-too-large');
        var buf = await file.slice(moof.start, moof.start + moof.size).arrayBuffer();
        var dv = new DataView(buf);
        var kids = walk(dv, moof.hdr, buf.byteLength);
        var prevTrafEnd = -1;
        for (var k = 0; k < kids.length; k++) {
            if (kids[k].type !== 'traf') continue;
            var tk = walk(dv, kids[k].start + kids[k].hdr, kids[k].start + kids[k].size);
            var tfhd = find(tk, 'tfhd');
            if (!tfhd) throw err('fragmented-traf-shape');
            var tf = fullBoxFlags(dv, tfhd), p = tfhd.start + tfhd.hdr + 4;
            var trackId = dv.getUint32(p); p += 4;
            var base = null;
            if (tf & TF_BASE_DATA_OFFSET) { base = u64(dv, p); p += 8; }
            var sdi = 1;
            if (tf & TF_SAMPLE_DESC) { sdi = dv.getUint32(p); p += 4; }
            var defDur = null, defSize = null, defFlags = null;
            if (tf & TF_DEF_DUR) { defDur = dv.getUint32(p); p += 4; }
            if (tf & TF_DEF_SIZE) { defSize = dv.getUint32(p); p += 4; }
            if (tf & TF_DEF_FLAGS) { defFlags = dv.getUint32(p); p += 4; }
            var rec = byId[trackId];
            if (!rec) continue;                                   // a track the moov does not describe
            var tx = trex[trackId];
            if (defDur === null) defDur = tx ? tx.dur : null;
            if (defSize === null) defSize = tx ? tx.size : null;
            if (defFlags === null) defFlags = tx ? tx.flags : null;
            if (sdi !== 1 || (tx && tx.sdi !== 1 && !(tf & TF_SAMPLE_DESC))) throw err('fragmented-stsd');
            if (base === null) base = (tf & TF_DEFAULT_BASE_IS_MOOF) || prevTrafEnd < 0 ? moof.start : prevTrafEnd;
            var pos = base, sawRun = false;
            for (var r = 0; r < tk.length; r++) {
                if (tk[r].type !== 'trun') continue;
                var trun = tk[r], tv = fullBoxVersion(dv, trun), fl = fullBoxFlags(dv, trun);
                var q = trun.start + trun.hdr + 4;
                var count = dv.getUint32(q); q += 4;
                if (fl & TR_DATA_OFFSET) { pos = base + dv.getInt32(q); q += 4; }
                var firstFlags = null;
                if (fl & TR_FIRST_FLAGS) { firstFlags = dv.getUint32(q); q += 4; }
                var chunkStart = pos, chunkCount = 0;
                for (var s = 0; s < count; s++) {
                    var dur = defDur, size = defSize, flags = defFlags, cts = 0;
                    if (fl & TR_DUR) { dur = dv.getUint32(q); q += 4; }
                    if (fl & TR_SIZE) { size = dv.getUint32(q); q += 4; }
                    if (fl & TR_FLAGS) { flags = dv.getUint32(q); q += 4; }
                    if (fl & TR_CTS) { cts = tv === 0 ? dv.getUint32(q) : dv.getInt32(q); q += 4; }
                    if (s === 0 && firstFlags !== null) flags = firstFlags;
                    if (dur === null || size === null) throw err('fragmented-trex-missing');
                    if (flags === null) flags = 0;
                    rec.samples.push({ off: pos, size: size, dur: dur, cts: cts, sync: !((flags >>> 16) & 1) });
                    pos += size; chunkCount++;
                }
                if (chunkCount) rec.chunks.push({ off: chunkStart, count: chunkCount });
                sawRun = true;
            }
            if (sawRun) prevTrafEnd = pos;
        }
    }
    return byId;
}

/* Box writers ------------------------------------------------------------ */
function boxHeader(type, payloadLen) {
    var h = new Uint8Array(8), v = new DataView(h.buffer);
    v.setUint32(0, payloadLen + 8);
    for (var i = 0; i < 4; i++) h[4 + i] = type.charCodeAt(i);
    return h;
}
function concatBytes(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), w = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], w); w += parts[i].length; }
    return out;
}
function box(type, parts) { var body = concatBytes(parts); return concatBytes([boxHeader(type, body.length), body]); }
function fullBox(type, version, flags, payload) {
    var head = new Uint8Array(4); head[0] = version; head[1] = (flags >>> 16) & 255; head[2] = (flags >>> 8) & 255; head[3] = flags & 255;
    return box(type, [head, payload]);
}
function u32Table(entries, perEntry) {       // entries: flat array of uint32 values, perEntry values per row
    var rows = entries.length / perEntry;
    var out = new Uint8Array(4 + entries.length * 4), v = new DataView(out.buffer);
    v.setUint32(0, rows);
    for (var i = 0; i < entries.length; i++) v.setUint32(4 + i * 4, entries[i] >>> 0);
    return out;
}

/* Derive the flat sample tables of one track from its samples and chunks. */
function buildSampleTables(rec) {
    var samples = rec.samples, chunks = rec.chunks, i;
    // stts — run-length of durations
    var stts = [], run = 0, cur = -1;
    for (i = 0; i < samples.length; i++) {
        if (samples[i].dur === cur) run++;
        else { if (run) stts.push(run, cur); cur = samples[i].dur; run = 1; }
    }
    if (run) stts.push(run, cur);
    // ctts — only when any composition offset is non-zero; v1 when any is negative
    var anyCts = false, anyNeg = false;
    for (i = 0; i < samples.length; i++) { if (samples[i].cts) anyCts = true; if (samples[i].cts < 0) anyNeg = true; }
    var ctts = null;
    if (anyCts) {
        var rows = []; run = 0; cur = null;
        for (i = 0; i < samples.length; i++) {
            if (samples[i].cts === cur) run++;
            else { if (run) rows.push(run, cur); cur = samples[i].cts; run = 1; }
        }
        if (run) rows.push(run, cur);
        ctts = fullBox('ctts', anyNeg ? 1 : 0, 0, u32Table(rows, 2));
    }
    // stss — omitted when every sample is a sync sample
    var syncs = [], allSync = true;
    for (i = 0; i < samples.length; i++) { if (samples[i].sync) syncs.push(i + 1); else allSync = false; }
    var stss = allSync ? null : fullBox('stss', 0, 0, u32Table(syncs, 1));
    // stsz — per-sample sizes (uniform when they all agree)
    var uniform = samples.length ? samples[0].size : 0;
    for (i = 1; i < samples.length; i++) if (samples[i].size !== uniform) { uniform = 0; break; }
    var stszPayload;
    if (uniform) { stszPayload = new Uint8Array(8); new DataView(stszPayload.buffer).setUint32(0, uniform); new DataView(stszPayload.buffer).setUint32(4, samples.length); }
    else {
        stszPayload = new Uint8Array(8 + samples.length * 4);
        var sv = new DataView(stszPayload.buffer); sv.setUint32(0, 0); sv.setUint32(4, samples.length);
        for (i = 0; i < samples.length; i++) sv.setUint32(8 + i * 4, samples[i].size);
    }
    var stsz = fullBox('stsz', 0, 0, stszPayload);
    // stsc — (first_chunk, samples_per_chunk, sample_description_index) run-length over chunks
    var stsc = []; cur = -1;
    for (i = 0; i < chunks.length; i++) {
        if (chunks[i].count !== cur) { stsc.push(i + 1, chunks[i].count, 1); cur = chunks[i].count; }
    }
    // stco / co64
    var wide = false;
    for (i = 0; i < chunks.length; i++) if (chunks[i].off > 4294967295) { wide = true; break; }
    var co;
    if (wide) {
        var cb = new Uint8Array(4 + chunks.length * 8), cv = new DataView(cb.buffer);
        cv.setUint32(0, chunks.length);
        for (i = 0; i < chunks.length; i++) { cv.setUint32(4 + i * 8, Math.floor(chunks[i].off / 4294967296)); cv.setUint32(8 + i * 8, chunks[i].off >>> 0); }
        co = fullBox('co64', 0, 0, cb);
    } else {
        var offs = [];
        for (i = 0; i < chunks.length; i++) offs.push(chunks[i].off);
        co = fullBox('stco', 0, 0, u32Table(offs, 1));
    }
    var duration = 0;
    for (i = 0; i < samples.length; i++) duration += samples[i].dur;
    var parts = [fullBox('stts', 0, 0, u32Table(stts, 2))];
    if (ctts) parts.push(ctts);
    if (stss) parts.push(stss);
    parts.push(stsz, fullBox('stsc', 0, 0, u32Table(stsc, 3)), co);
    return { boxes: parts, duration: duration };
}

/* Copy a full box's bytes with its duration field rewritten (mvhd/tkhd/mdhd).
   `durAt` is the offset of the duration field for version 0 (32-bit); for
   version 1 the field is 64-bit and sits 12 bytes later (three 64-bit
   timestamps instead of 32-bit ones precede it in mvhd/mdhd, two in tkhd). */
function copyWithDuration(src, dv, b, durAtV0, durAtV1, duration) {
    var out = new Uint8Array(src.subarray(b.start, b.start + b.size));   // copy
    var ov = new DataView(out.buffer);
    var ver = ov.getUint8(b.hdr);
    if (ver === 1) {
        ov.setUint32(b.hdr + durAtV1, Math.floor(duration / 4294967296));
        ov.setUint32(b.hdr + durAtV1 + 4, duration >>> 0);
    } else {
        ov.setUint32(b.hdr + durAtV0, Math.min(4294967295, duration));
    }
    return out;
}

/* mvhd: version(1) flags(3) | v0: creation(4) modification(4) timescale(4) duration(4)
                               | v1: creation(8) modification(8) timescale(4) duration(8) */
function mvhdTimescale(dv, mvhd) { var v = fullBoxVersion(dv, mvhd), p = mvhd.start + mvhd.hdr + 4; return v === 1 ? dv.getUint32(p + 16) : dv.getUint32(p + 8); }
function mdhdTimescale(dv, mdhd) { var v = fullBoxVersion(dv, mdhd), p = mdhd.start + mdhd.hdr + 4; return v === 1 ? dv.getUint32(p + 16) : dv.getUint32(p + 8); }

/* Build the flat moov. Returns an ArrayBuffer whose first 8 bytes are the
   moov header, or throws with a named reason. */
async function flattenMoov(file, top, moovBuf, moovBox) {
    var dv = new DataView(moovBuf), src = new Uint8Array(moovBuf);
    var kids = walk(dv, moovBox.hdr, moovBuf.byteLength);
    var mvex = find(kids, 'mvex'), mvhd = find(kids, 'mvhd');
    if (!mvex || !mvhd) throw err('fragmented-shape');
    var trex = readTrex(dv, mvex);
    var movieTs = mvhdTimescale(dv, mvhd);
    // describe the tracks: id, mdia/mdhd, minf, stbl/stsd
    var tracks = [], i, k;
    for (i = 0; i < kids.length; i++) {
        if (kids[i].type !== 'trak') continue;
        var t = describeTrak(dv, kids[i]);
        var tkids = walk(dv, kids[i].start + kids[i].hdr, kids[i].start + kids[i].size);
        var mdia = find(tkids, 'mdia');
        if (!mdia || !t.stbl || !t.stbl.stsd) throw err('fragmented-shape');
        var mkids = walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size);
        var mdhd = find(mkids, 'mdhd'), minf = find(mkids, 'minf');
        if (!mdhd || !minf) throw err('fragmented-shape');
        var nkids = walk(dv, minf.start + minf.hdr, minf.start + minf.size);
        var stbl = find(nkids, 'stbl');
        tracks.push({ id: t.id, box: kids[i], tkids: tkids, mdia: mdia, mkids: mkids, mdhd: mdhd, minf: minf, nkids: nkids, stbl: stbl, stsd: t.stbl.stsd, mediaTs: mdhdTimescale(dv, mdhd) });
    }
    if (!tracks.length) throw err('no-tracks');
    var frags = await collectFragments(file, top, trex, tracks);

    var trakBoxes = [], movieDur = 0;
    for (i = 0; i < tracks.length; i++) {
        var tr = tracks[i], rec = frags[tr.id];
        if (!rec || !rec.samples.length) continue;                 // a track without fragments has nothing to play
        var tables = buildSampleTables(rec);
        var mediaDur = tables.duration;
        var trackDurMovie = tr.mediaTs > 0 ? Math.round(mediaDur / tr.mediaTs * movieTs) : 0;
        if (trackDurMovie > movieDur) movieDur = trackDurMovie;
        // stbl: stsd verbatim + derived tables; nothing else from the fragmented stbl
        var stblParts = [src.subarray(tr.stsd.start, tr.stsd.start + tr.stsd.size)].concat(tables.boxes);
        var stblBox = box('stbl', stblParts);
        // minf: every child verbatim except stbl
        var minfParts = [];
        for (k = 0; k < tr.nkids.length; k++) {
            if (tr.nkids[k].type === 'stbl') minfParts.push(stblBox);
            else minfParts.push(src.subarray(tr.nkids[k].start, tr.nkids[k].start + tr.nkids[k].size));
        }
        if (!tr.stbl) minfParts.push(stblBox);
        var minfBox = box('minf', minfParts);
        // mdia: mdhd with the media duration, hdlr & co verbatim, new minf
        var mdiaParts = [];
        for (k = 0; k < tr.mkids.length; k++) {
            var mk = tr.mkids[k];
            if (mk.type === 'mdhd') mdiaParts.push(copyWithDuration(src, dv, mk, 16, 24, mediaDur));
            else if (mk.type === 'minf') mdiaParts.push(minfBox);
            else mdiaParts.push(src.subarray(mk.start, mk.start + mk.size));
        }
        var mdiaBox = box('mdia', mdiaParts);
        // trak: tkhd with the movie-timescale duration, edts/tref/udta verbatim, new mdia
        var trakParts = [];
        for (k = 0; k < tr.tkids.length; k++) {
            var tkk = tr.tkids[k];
            if (tkk.type === 'tkhd') trakParts.push(copyWithDuration(src, dv, tkk, 20, 28, trackDurMovie));
            else if (tkk.type === 'mdia') trakParts.push(mdiaBox);
            else trakParts.push(src.subarray(tkk.start, tkk.start + tkk.size));
        }
        trakBoxes.push(box('trak', trakParts));
    }
    if (!trakBoxes.length) throw err('fragmented-no-samples');
    // moov: mvhd with the movie duration, traks rebuilt, mvex dropped, the rest verbatim
    var moovParts = [], trakPushed = false;
    for (i = 0; i < kids.length; i++) {
        var kd = kids[i];
        if (kd.type === 'mvhd') moovParts.push(copyWithDuration(src, dv, kd, 16, 24, movieDur));
        else if (kd.type === 'mvex') continue;
        else if (kd.type === 'trak') { if (!trakPushed) { moovParts.push.apply(moovParts, trakBoxes); trakPushed = true; } }
        else moovParts.push(src.subarray(kd.start, kd.start + kd.size));
    }
    if (!trakPushed) moovParts.push.apply(moovParts, trakBoxes);
    var out = box('moov', moovParts);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/* Read a moov and, when it is fragmented, return the flat one instead. The
   returned box descriptor has hdr 8 and the flat buffer's size. */
async function moovFlatOrAsIs(file, top, moovBox) {
    var moovBuf = await file.slice(moovBox.start, moovBox.start + moovBox.size).arrayBuffer();
    var dv = new DataView(moovBuf);
    var kids = walk(dv, moovBox.hdr, moovBuf.byteLength);
    if (!find(kids, 'mvex')) return { buf: moovBuf, box: moovBox, flattened: false };
    var flat = await flattenMoov(file, top, moovBuf, moovBox);
    return { buf: flat, box: { type: 'moov', start: moovBox.start, size: flat.byteLength, hdr: 8 }, flattened: true };
}

/* replaceAudio ----------------------------------------------------------- */

/* Read the moov of an mp4-family file: top-level boxes, the moov's DataView,
   its children and every trak described. Shared by remux() and replaceAudio(). */
async function loadMoov(file) {
    if (!looksSupported(file)) throw err('not-mp4-family');
    var top = await topLevel(file);
    var moovBox = find(top, 'moov');
    if (!moovBox) throw err('no-moov');
    if (moovBox.size > MOOV_MAX) throw err('moov-too-large');
    var mv = await moovFlatOrAsIs(file, top, moovBox);
    var moovBuf = mv.buf; moovBox = mv.box;
    var dv = new DataView(moovBuf);
    var kids = walk(dv, moovBox.hdr, moovBuf.byteLength);
    var walked = kids.length ? kids[kids.length - 1].start + kids[kids.length - 1].size : moovBox.hdr;
    if (walked !== moovBuf.byteLength) throw err('moov-walk-short');
    var traks = [];
    for (var i = 0; i < kids.length; i++) if (kids[i].type === 'trak') traks.push(describeTrak(dv, kids[i]));
    if (!traks.length) throw err('no-tracks');
    return { top: top, moovBox: moovBox, ftypBox: find(top, 'ftyp'), buf: moovBuf, dv: dv, kids: kids, traks: traks, flattened: mv.flattened };
}

/* A trak as the writer below handles it: its bytes (exactly the trak box — a
   view into a source moov, or a box rebuilt here), the File its samples live
   in, its chunk-offset table (positions relative to `bytes`), the length of
   every chunk and the byte ranges they cover in that File. */
function trakEntry(bytes, file) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var desc = describeTrak(dv, { type: 'trak', start: 0, size: bytes.byteLength, hdr: dv.getUint32(0) === 1 ? 16 : 8 });
    if (desc.external) throw err('external-media');
    if (!desc.stbl || !desc.stbl.stco || !desc.stbl.stsc) throw err('unsupported-sample-table');
    var co = readChunkOffsets(dv, desc.stbl.stco);
    var lens = chunkLengths(co.count, readStsc(dv, desc.stbl.stsc), readSampleSizes(dv, desc.stbl.stsz, desc.stbl.stz2));
    var ranges = [];
    for (var c = 0; c < co.count; c++) {
        if (lens[c] > 0) ranges.push({ start: co.offsets[c], end: co.offsets[c] + lens[c] });
    }
    return { bytes: bytes, file: file, dv: dv, desc: desc, co: co, lens: lens, ranges: ranges };
}

/* The mdhd (timescale, duration) and tkhd field offsets of a trak, for the
   one rewrite replaceAudio has to make inside a foreign trak. An edit list is
   not refused here: replaceAudio has already re-expressed it in the movie's
   clock by the time this reads the trak (see «The soundtrack's edit list»). */
function trakClocks(dv, trak) {
    var kids = walk(dv, trak.start + trak.hdr, trak.start + trak.size);
    var tkhd = find(kids, 'tkhd'), mdia = find(kids, 'mdia');
    if (!tkhd || !mdia) throw err('audio-trak-shape');
    if (find(kids, 'tref')) throw err('audio-tref');
    var mdhd = find(walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size), 'mdhd');
    if (!mdhd) throw err('audio-trak-shape');
    var mv = dv.getUint8(mdhd.start + mdhd.hdr), mp = mdhd.start + mdhd.hdr + 4;
    var timescale = mv === 1 ? dv.getUint32(mp + 16) : dv.getUint32(mp + 8);
    var duration  = mv === 1 ? u64(dv, mp + 20)      : dv.getUint32(mp + 12);
    var tv = dv.getUint8(tkhd.start + tkhd.hdr), tp = tkhd.start + tkhd.hdr + 4;
    // v1: creation(8) modification(8) track_ID(4) reserved(4) duration(8); v0: 4 4 4 4 4
    var idAt = tv === 1 ? tp + 16 : tp + 8;
    var durAt = idAt + 8;
    return { timescale: timescale, duration: duration, idAt: idAt, durAt: durAt, durWide: tv === 1 };
}

/* writing the output ------------------------------------------------------ */

/* Build an mdat header for `payload` bytes. */
function mdatHeader(payload) {
    var hdr = payload + 8 > 4294967295 ? 16 : 8;
    var head = new Uint8Array(hdr), mdv = new DataView(head.buffer);
    if (hdr === 16) {
        mdv.setUint32(0, 1); mdv.setUint32(4, 0x6d646174);
        mdv.setUint32(8, Math.floor((payload + 16) / 4294967296)); mdv.setUint32(12, (payload + 16) >>> 0);
    } else {
        mdv.setUint32(0, payload + 8); mdv.setUint32(4, 0x6d646174);
    }
    return head;
}

/* Old offset -> new offset over a sorted, laid-out part list. */
function offsetMapper(parts, dataStart) {
    return function (off) {
        var lo = 0, hi = parts.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (off < parts[mid].start) hi = mid - 1;
            else if (off >= parts[mid].end) lo = mid + 1;
            else return dataStart + parts[mid].newStart + (off - parts[mid].start);
        }
        throw err('offset-unmapped');
    };
}

/* Chunk offsets past 4 GiB ------------------------------------------------
 *
 * An `stco` holds 32-bit file positions, so a file may carry one only while
 * every chunk it points at starts below 4 GiB. Both builders lay the kept
 * bytes out anew — moov first, then the picture, then (replaceAudio) the new
 * soundtrack — so a table can cross that line in the OUTPUT although it was
 * fine in its source:
 *   · the soundtrack of a video of more than ~4 GiB: the m4a says `stco`, and
 *     the soundtrack lands after the whole picture. Premium chat 657,
 *     01.10.2026: 5.5 GB, 49:48, 1080p 120 fps — recognised, censored,
 *     rendered in 100 s, then refused `offset-overflow`, twice, with the clean
 *     sound left to download on its own; every tool on this splice
 *     (/video-volume, /add-music-to-video, /video-audio, /video-dubbing,
 *     /redub) refused the same way from 4 GiB up;
 *   · a picture whose chunks sat just under 4 GiB behind a trailing moov,
 *     which the output moves to the front.
 * Such a table is written as `co64` — what ISO/IEC 14496-12 §8.7.5 has it for,
 * and what FFmpeg's mov muxer does in the same place (co64_required(), and
 * the second size pass of compute_moov_size() for the moov that grew). A
 * table that fits keeps its 32 bits: an output under 4 GiB is byte for byte
 * what it was. Only the chunk-offset box changes; its trak, mdia, minf and
 * stbl get new headers for the new size, every other child is copied as is.
 */
function trakWithCo64(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var path = ['mdia', 'minf', 'stbl'];
    function rebuild(b, depth) {
        var kids = walk(dv, b.start + b.hdr, b.start + b.size), parts = [], hits = 0;
        var end = kids.length ? kids[kids.length - 1].start + kids[kids.length - 1].size : b.start + b.hdr;
        if (end !== b.start + b.size) throw err('unsupported-sample-table');   // a child we cannot walk: never drop it silently
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (depth < path.length && k.type === path[depth]) { parts.push(rebuild(k, depth + 1)); hits++; }
            else if (depth === path.length && k.type === 'stco') { parts.push(co64From(dv, k)); hits++; }
            else parts.push(bytes.subarray(k.start, k.start + k.size));
        }
        if (hits !== 1) throw err('unsupported-sample-table');
        return box(b.type, parts);
    }
    return rebuild({ type: 'trak', start: 0, size: bytes.byteLength, hdr: dv.getUint32(0) === 1 ? 16 : 8 }, 0);
}
function co64From(dv, stco) {
    var p = stco.start + stco.hdr + 4, n = dv.getUint32(p);
    if (p + 4 + n * 4 > stco.start + stco.size) throw err('unsupported-sample-table');
    var body = new Uint8Array(4 + n * 8), bv = new DataView(body.buffer);
    bv.setUint32(0, n);
    for (var i = 0; i < n; i++) bv.setUint32(8 + i * 8, dv.getUint32(p + 4 + i * 4));   // high words stay 0
    return fullBox('co64', 0, 0, body);
}

/* Which 32-bit tables cannot hold their new offsets, and widen those. A
   trak's chunk lands at the payload start plus `rel`; `fixed` is that start
   with every table at its source width. Widening a table grows the moov by
   4 bytes a chunk and moves every chunk behind it, which may push another
   table over — so repeat until a pass widens nothing (a pass only ever
   adds, so this ends within one pass per table). Returns how many. */
function widenWhereNeeded(traks, fixed) {
    var grown = 0, again = true, n = 0, i, t;
    while (again) {
        again = false;
        for (i = 0; i < traks.length; i++) {
            t = traks[i];
            if (t.co.wide || t.widen) continue;
            if (t.relMax === undefined) t.relMax = lastChunkAt(t);
            if (t.relMax < 0 || fixed + grown + t.relMax <= 4294967295) continue;
            t.widen = true;
            grown += 4 * t.co.count;
            again = true;
        }
    }
    for (i = 0; i < traks.length; i++) {
        t = traks[i];
        if (!t.widen) continue;
        var w = trakEntry(trakWithCo64(t.bytes), t.file);   // same chunks and lengths, now in a co64
        t.bytes = w.bytes; t.dv = w.dv; t.desc = w.desc; t.co = w.co;
        n++;
    }
    return n;
}
function lastChunkAt(t) {
    var m = -1;
    for (var c = 0; c < t.co.count; c++) {
        if (t.lens[c] > 0) { var r = t.rel(t.co.offsets[c]); if (r > m) m = r; }
    }
    return m;
}

function writeOffsets(outDv, base, t, dataStart) {
    var co = t.co;
    for (var j = 0; j < co.count; j++) {
        var newOff = t.lens[j] > 0 ? dataStart + t.rel(co.offsets[j]) : 0;
        if (co.wide) {
            outDv.setUint32(base + j * 8, Math.floor(newOff / 4294967296));
            outDv.setUint32(base + j * 8 + 4, newOff >>> 0);
        } else {
            if (newOff > 4294967295) throw err('offset-overflow');   // widenWhereNeeded said it fits
            outDv.setUint32(base + j * 4, newOff);
        }
    }
}

function moovLength(pieces) {
    var n = 8;
    for (var i = 0; i < pieces.length; i++) n += (pieces[i].trak ? pieces[i].trak.bytes : pieces[i].bytes).length;
    return n;
}

/* The one writer both builders share: [ftyp] moov mdat.
 *   o.pieces  the new moov's children in order — { bytes } copied as is,
 *             { trak: entry } a trak whose chunk offsets are written here;
 *             either may carry fix(outDv, at) to patch a field of its own
 *             once its place in the moov is known
 *   o.groups  the mdat, in order: { file, traks, maxParts } — the traks whose
 *             samples live in one File, coalesced together under one budget
 *   o.ftyp / o.ftypLen / o.overheadBudget / o.mime
 * Returns { blob, parts, waste, widened }. */
function writeFile(o) {
    var payload = 0, waste = 0, traks = [], i, j;
    for (i = 0; i < o.groups.length; i++) {
        var g = o.groups[i], ranges = [];
        for (j = 0; j < g.traks.length; j++) ranges = ranges.concat(g.traks[j].ranges);
        var packed = coalesce(ranges, g.maxParts, o.overheadBudget);
        waste += packed.waste;
        g.parts = packed.ranges;
        for (j = 0; j < g.parts.length; j++) { g.parts[j].newStart = payload; payload += g.parts[j].end - g.parts[j].start; }
        var rel = offsetMapper(g.parts, 0);
        for (j = 0; j < g.traks.length; j++) { g.traks[j].rel = rel; traks.push(g.traks[j]); }
    }
    /* Payload size decides whether mdat needs the 64-bit header, and the
       header size decides where the payload starts — not the other way round. */
    var mdatHead = mdatHeader(payload);
    var widened = widenWhereNeeded(traks, o.ftypLen + moovLength(o.pieces) + mdatHead.length);

    var moovLen = moovLength(o.pieces);
    var dataStart = o.ftypLen + moovLen + mdatHead.length;
    var moovOut = new Uint8Array(moovLen), outDv = new DataView(moovOut.buffer);
    outDv.setUint32(0, moovLen);
    outDv.setUint32(4, 0x6d6f6f76);                                  // 'moov'
    var at = 8;
    for (i = 0; i < o.pieces.length; i++) {
        var p = o.pieces[i], b = p.trak ? p.trak.bytes : p.bytes;
        moovOut.set(b, at);
        if (p.trak) writeOffsets(outDv, at + p.trak.co.base, p.trak, dataStart);
        if (p.fix) p.fix(outDv, at);
        at += b.length;
    }

    var blobParts = [];
    if (o.ftyp) blobParts.push(o.ftyp);
    blobParts.push(moovOut, mdatHead);
    for (i = 0; i < o.groups.length; i++) {
        var gp = o.groups[i];
        for (j = 0; j < gp.parts.length; j++) blobParts.push(gp.file.slice(gp.parts[j].start, gp.parts[j].end));
    }
    return { blob: new Blob(blobParts, { type: o.mime }), parts: blobParts.length, waste: waste, widened: widened };
}

/* The soundtrack's edit list --------------------------------------------- */

/* An m4a written by FFmpeg carries an edit list: one edit whose media_time
 * skips the AAC encoder's priming (1024 samples for FFmpeg's `aac`). Until
 * 29.09.2026 replaceAudio refused it (`audio-edts`) — every caller fed it
 * mp4-muxer output, which has none. /profanity-remover-video is the first
 * caller whose soundtrack FFmpeg renders (the censor graph lives there and
 * nowhere else), so the edit list has to travel with the trak: without it the
 * priming plays and the whole soundtrack sits 21 ms late.
 *
 * segment_duration counts in the MOVIE's clock (mvhd timescale), and the
 * m4a's movie clock is not the video's (FFmpeg writes 1000, an iPhone .mov
 * 600, some cameras 90000), so every segment is re-expressed in the video's
 * clock. media_time counts in the trak's own mdhd clock, which travels with
 * the trak unchanged, so it is copied as is. tkhd.duration becomes the sum of
 * the segments — the presentation length, priming excluded.
 *
 * ⛔ Not a place to move the soundtrack along the timeline (an empty edit in
 * front, a later media_time): Media Foundation ignores an audio edit list's
 * offset — measured on /video-trim, docs/why/primitives/frame-exact-trim.md —
 * so a shift expressed here plays on Windows as if it were not there. A
 * caller that needs one renders it into the samples (silence ahead, a trim).
 * The priming edit is the one FFmpeg's own mux writes too, so every player
 * treats the output exactly as it treated FFmpeg's.
 *
 * Anything outside that shape (a rate other than 1, a negative media_time
 * other than the empty edit's −1) is still refused by name, `audio-edts`. */
function readElst(dv, trak) {
    var edts = find(walk(dv, trak.start + trak.hdr, trak.start + trak.size), 'edts');
    if (!edts) return null;
    var elst = find(walk(dv, edts.start + edts.hdr, edts.start + edts.size), 'elst');
    if (!elst) return null;
    var p = elst.start + elst.hdr, v = dv.getUint8(p), n = dv.getUint32(p + 4), out = [];
    p += 8;
    if (p + n * (v === 1 ? 20 : 12) > elst.start + elst.size) throw err('audio-edts');
    for (var i = 0; i < n; i++) {
        var seg, mt;
        if (v === 1) { seg = u64(dv, p); mt = dv.getInt32(p + 8) * 4294967296 + dv.getUint32(p + 12); p += 16; }
        else { seg = dv.getUint32(p); mt = dv.getInt32(p + 4); p += 8; }
        var rateInt = dv.getInt16(p), rateFrac = dv.getInt16(p + 2);
        p += 4;
        if (mt < -1 || (mt !== -1 && (rateInt !== 1 || rateFrac !== 0))) throw err('audio-edts');
        out.push({ seg: seg, mt: mt });
    }
    return out;
}

/* The movie time (seconds) of a trak's first PRESENTED sample: the sum of
   its leading empty edits — what ffprobe calls the stream's start_time. 0
   without an edit list; null when the edit list has a shape readElst refuses
   (rate ≠ 1) or the movie clock is missing. The first edit's media_time does
   NOT enter it: the browser decoders skip to it (FFmpeg's skip_samples,
   Mp4EditList), so that sample IS the decoded sound's zero — measured
   01.10.2026 with a flash/beep identity dub: subtracting the 1024-sample AAC
   priming put an ordinary file's voice 21 ms early.
   Why a caller needs it (/video-dubbing): a track that starts 0.48 s after
   the picture decodes WITHOUT those 0.48 s, so whatever is built on that
   timeline must be put back at this time, or it plays early — the dubbing
   mux did, by exactly that much. */
function trackStartSec(dv, trak, movieTs) {
    var edits;
    try { edits = readElst(dv, trak); } catch (e) { return null; }
    if (!edits || !edits.length) return 0;
    if (!(movieTs > 0)) return null;
    var empty = 0;
    for (var k = 0; k < edits.length && edits[k].mt === -1; k++) empty += edits[k].seg;
    return empty / movieTs;
}

/* The edit list the spliced trak gets, in the VIDEO's movie clock; null when
   the m4a has none (the mp4-muxer case — the trak goes in as before). */
function planEdits(src, srcMovieTs, movieTs) {
    if (!src || !src.length) return null;
    if (!(srcMovieTs > 0)) throw err('audio-edts');
    return src.map(function (e) { return { seg: Math.round(e.seg * movieTs / srcMovieTs), mt: e.mt }; });
}

function elstBox(edits) {
    var wide = false, i;
    for (i = 0; i < edits.length; i++) if (edits[i].seg > 4294967295 || edits[i].mt > 2147483647) wide = true;
    var per = wide ? 20 : 12, body = new Uint8Array(4 + edits.length * per), bv = new DataView(body.buffer);
    bv.setUint32(0, edits.length);
    for (i = 0; i < edits.length; i++) {
        var o = 4 + i * per, e = edits[i];
        if (wide) {
            bv.setUint32(o, Math.floor(e.seg / 4294967296)); bv.setUint32(o + 4, e.seg >>> 0);
            bv.setInt32(o + 8, e.mt === -1 ? -1 : Math.floor(e.mt / 4294967296)); bv.setUint32(o + 12, e.mt === -1 ? 0xFFFFFFFF : e.mt >>> 0);
            o += 16;
        } else {
            bv.setUint32(o, e.seg); bv.setInt32(o + 4, e.mt);
            o += 8;
        }
        bv.setInt16(o, 1); bv.setInt16(o + 2, 0);
    }
    return box('edts', [fullBox('elst', wide ? 1 : 0, 0, body)]);
}

/* The trak rebuilt with `edits` right after its tkhd (where ISO puts edts),
   tkhd.duration set to their sum; every other child copied as is. */
function trakWithEdits(src, dv, trak, edits) {
    var kids = walk(dv, trak.start + trak.hdr, trak.start + trak.size), total = 0, parts = [], i;
    for (i = 0; i < edits.length; i++) total += edits[i].seg;
    for (i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.type === 'edts') continue;
        var bytes = src.slice(k.start, k.start + k.size);
        if (k.type === 'tkhd') {
            var tv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ver = bytes[k.hdr];
            var durAt = k.hdr + 4 + (ver === 1 ? 24 : 16);
            if (ver === 1) { tv.setUint32(durAt, Math.floor(total / 4294967296)); tv.setUint32(durAt + 4, total >>> 0); }
            else if (total > 4294967295) throw err('audio-edts');
            else tv.setUint32(durAt, total);
            parts.push(bytes, elstBox(edits));
            continue;
        }
        parts.push(bytes);
    }
    var out = box('trak', parts), odv = new DataView(out.buffer);
    return { buf: out.buffer, dv: odv, trak: describeTrak(odv, { type: 'trak', start: 0, size: out.length, hdr: 8 }), ticks: total };
}

/* The picture's B-frame delay — at zero in the samples, not behind an edit
 * list (28.10.2026) ------------------------------------------------------
 *
 * A stream with B-frames is decoded ahead of the order it is shown in, so its
 * first shown frame has a composition time after zero (x264's default: two
 * frames). The usual mp4 hides that delay in the video's edit list
 * (media_time = the delay). Media Foundation — the Source Reader the Windows
 * players use — does not read edit lists, so it shows the picture that much
 * LATE; the soundtrack we splice in has no such delay, so on Windows it plays
 * early by it. Measured on /video-volume's output (flash frames + clicks at
 * the same instants, ffmpeg with and without the edit list, which is what
 * Media Foundation sees — docs/why/mp4-timing-windows.md): 24 fps, 2 B-frames
 * → the sound 83 ms early; 30 fps, 3 B-frames → 67 ms; no B-frames → 0.
 * Chrome, Firefox and ffmpeg read the edit list and had it right.
 *
 * So, in an ISO-family destination, the delay moves INTO the samples the way
 * FFmpeg's mov muxer does it with `-movflags negative_cts_offsets` (checked
 * against its output): every composition offset minus S, the table becomes a
 * signed `ctts` v1, every non-empty edit's media_time minus S, where S = the
 * smaller of the first non-empty edit's media_time and the earliest
 * composition time — the B-frame delay, never more. A media_time beyond it
 * (a source cut with a copy remux keeps its pre-roll and skips it here) stays
 * in the edit list, as FFmpeg keeps it: nothing is shown at a negative time.
 * The patch is in place — same box sizes, every other byte as it was — so
 * players that read edit lists present exactly the frames at exactly the
 * times they did before, and a file without B-frames is untouched.
 *
 * Not here: a QuickTime movie (the iPhone `.mov` path). AVFoundation's reading
 * of a v1 table in a `qt  ` movie is not something this repo can measure, and
 * that form was proven on iPhones as it is (see «QuickTime destination»); the
 * delay found there is reported, not moved. A source with `cslg` (its own
 * composition shift) is left alone too — its numbers would go stale. */
function videoDelayAtZero(bytes, apply) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var none = { bytes: bytes, zeroMs: 0, keptMs: 0, pendingMs: 0 };
    var hdr0 = dv.getUint32(0) === 1 ? 16 : 8;
    var tk = walk(dv, hdr0, bytes.byteLength);
    var edts = find(tk, 'edts'), mdia = find(tk, 'mdia');
    if (!edts || !mdia) return none;
    var elst = find(walk(dv, edts.start + edts.hdr, edts.start + edts.size), 'elst');
    var mk = walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size);
    var mdhd = find(mk, 'mdhd'), minf = find(mk, 'minf');
    var stbl = minf && find(walk(dv, minf.start + minf.hdr, minf.start + minf.size), 'stbl');
    if (!elst || !mdhd || !stbl) return none;
    var sk = walk(dv, stbl.start + stbl.hdr, stbl.start + stbl.size);
    var ctts = find(sk, 'ctts'), stts = find(sk, 'stts');
    if (!ctts || !stts || find(sk, 'cslg')) return none;
    var ts = mdhdTimescale(dv, mdhd);
    if (!(ts > 0)) return none;

    // the non-empty edits' media_time fields, and the smallest of them
    var ep = elst.start + elst.hdr, ev = dv.getUint8(ep), en = dv.getUint32(ep + 4), at = [], M = Infinity, i;
    ep += 8;
    if (ep + en * (ev === 1 ? 20 : 12) > elst.start + elst.size) return none;
    for (i = 0; i < en; i++) {
        var mtAt = ep + (ev === 1 ? 8 : 4);
        var mt = ev === 1 ? dv.getInt32(mtAt) * 4294967296 + dv.getUint32(mtAt + 4) : dv.getInt32(mtAt);
        if (mt !== -1) { at.push(mtAt); if (mt < M) M = mt; }
        ep += ev === 1 ? 20 : 12;
    }
    if (!at.length || !(M > 0)) return none;

    // the earliest composition time: decode times (stts) + offsets (ctts)
    var cp = ctts.start + ctts.hdr, cv = dv.getUint8(cp), cn = dv.getUint32(cp + 4);
    var sp = stts.start + stts.hdr, sn = dv.getUint32(sp + 4);
    cp += 8; sp += 8;
    if (cp + cn * 8 > ctts.start + ctts.size || sp + sn * 8 > stts.start + stts.size) return none;
    var minCt = Infinity, dts = 0, sLeft = 0, sDur = 0, si = 0;
    for (i = 0; i < cn; i++) {
        var count = dv.getUint32(cp + i * 8), off = cv === 1 ? dv.getInt32(cp + i * 8 + 4) : dv.getUint32(cp + i * 8 + 4);
        if (cv !== 1 && off > 2147483647) return none;         // a v0 table with signed values — ambiguous, leave it
        for (var k = 0; k < count; k++) {
            while (sLeft === 0) { if (si >= sn) return none; sLeft = dv.getUint32(sp + si * 8); sDur = dv.getUint32(sp + si * 8 + 4); si++; }
            if (dts + off < minCt) minCt = dts + off;
            dts += sDur; sLeft--;
        }
    }
    var S = Math.min(M, minCt);
    if (!(S > 0) || !isFinite(S)) return none;
    var out = { bytes: bytes, zeroMs: 0, keptMs: Math.round((M - S) / ts * 1000), pendingMs: Math.round(S / ts * 1000) };
    if (!apply) return out;

    var patched = new Uint8Array(bytes), pv = new DataView(patched.buffer);   // copy
    pv.setUint8(ctts.start + ctts.hdr, 1);                                     // signed offsets from here on
    for (i = 0; i < cn; i++) {
        var o = cp + i * 8 + 4;
        pv.setInt32(o, (cv === 1 ? pv.getInt32(o) : pv.getUint32(o)) - S);
    }
    for (i = 0; i < at.length; i++) {
        if (ev === 1) {
            var v64 = pv.getInt32(at[i]) * 4294967296 + pv.getUint32(at[i] + 4) - S;
            pv.setInt32(at[i], Math.floor(v64 / 4294967296)); pv.setUint32(at[i] + 4, v64 >>> 0);
        } else {
            pv.setInt32(at[i], pv.getInt32(at[i]) - S);
        }
    }
    return { bytes: patched, zeroMs: out.pendingMs, keptMs: out.keptMs, pendingMs: 0 };
}

/* QuickTime destination -------------------------------------------------- */

/* A soundtrack spliced into a QuickTime movie must be WRITTEN AS QuickTime.
 *
 * Field record (RU, 12–27.09.2026, the result player's decode error right
 * after the file was produced): on iPhones a `.mov` that went through this
 * splice failed to play in 118 of 155 /add-music-to-video exports and 32 of 35
 * /video-volume ones, while `.mp4` from the same lane failed 1 of 95 and the
 * SAME native AAC stream copied into the same `.mov` by FFmpeg (`remux:ffmpeg`)
 * failed 0 of 19. The stream was fine; the container we wrote was not.
 * Complaint 27.09.2026 (Premium, iPhone, chat 653): «Видео зависает,
 * невозможно прослушать» — about the file she had just downloaded.
 *
 * The m4a comes from mp4-muxer, i.e. in ISO form, and three of its boxes mean
 * something else to a QuickTime reader (an iPhone `.mov` has ftyp `qt  `, so
 * AVFoundation reads the whole moov by QTFF rules):
 *   · `mp4a` version 0 with `esds` right inside the entry. QTFF puts the
 *     decoder configuration inside `wave` of a version-1 SoundDescription;
 *     without it the AAC decoder has no magic cookie. Chrome and Media
 *     Foundation read both forms (verified — both play our output), which is
 *     why only iPhones saw it.
 *   · `hdlr` names are counted (Pascal) strings in QuickTime; mp4-muxer's
 *     C string «mp4-muxer-hdlr\0» reads as a 109-byte name inside a 47-byte box.
 *   · QuickTime media carry a data-handler `hdlr` in `minf`.
 * So the trak is rebuilt in exactly the form FFmpeg's mov muxer writes for
 * AAC (mov_write_audio_tag, MODE_MOV: v1, compressionID −2, samples per packet,
 * wave{frma, mp4a, esds, terminator}, chan) — the form those 19 files proved.
 * Everything else — tkhd, mdhd, dinf, the sample tables — is copied verbatim,
 * so chunk offsets are still patched the usual way. Anything outside the shape
 * mp4-muxer writes is refused by name, and the caller's FFmpeg copy remux
 * (proven on this exact case) takes the job. */
async function isQuickTimeMovie(file, ftypBox) {
    if (!ftypBox) return true;                       // pre-ftyp QuickTime
    var b = new Uint8Array(await file.slice(ftypBox.start + ftypBox.hdr, ftypBox.start + ftypBox.hdr + 4).arrayBuffer());
    return b.length === 4 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'qt  ';
}

var QT_CHANNEL_LAYOUT = { 1: 0x00640001, 2: 0x00650002 };   // kAudioChannelLayoutTag_Mono / _Stereo

/* ftyp for an audio file — the box FFmpeg's ipod muxer writes for .m4a
   (major `M4A `, minor 0x200, compatible M4A/isom/iso2), the form every player
   we test opened (Chromium, Firefox, Media Foundation; 2026-10-08). */
function brandFtyp(major) {
    var m = String(major || 'M4A ').slice(0, 4);
    while (m.length < 4) m += ' ';
    return concatBytes([u32Bytes(28), asciiBytes('ftyp'), asciiBytes(m), u32Bytes(0x200),
        asciiBytes(m), asciiBytes('isom'), asciiBytes('iso2')]);
}

function asciiBytes(s) { var o = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; }
function u32Bytes() {
    var o = new Uint8Array(arguments.length * 4), v = new DataView(o.buffer);
    for (var i = 0; i < arguments.length; i++) v.setUint32(i * 4, arguments[i] >>> 0);
    return o;
}
function qtHandler(type, subtype, name) {
    var nm = asciiBytes(name), counted = new Uint8Array(nm.length + 1);
    counted[0] = nm.length; counted.set(nm, 1);
    return fullBox('hdlr', 0, 0, concatBytes([asciiBytes(type), asciiBytes(subtype), new Uint8Array(12), counted]));
}

/* ISO `mp4a` entry (bytes of the whole entry box) -> QuickTime SoundDescription v1. */
function qtSoundEntry(entry, samplesPerPacket) {
    var ev = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    if (entry.length < 36 || fourcc(ev, 4) !== 'mp4a') throw err('qt-audio-entry');
    if (ev.getUint16(16) !== 0) throw err('qt-audio-entry');          // already a QuickTime v1/v2 entry
    var dataRef = ev.getUint16(14), channels = ev.getUint16(24), rate = ev.getUint32(32) >>> 16;
    if (!QT_CHANNEL_LAYOUT[channels]) throw err('qt-audio-channels');
    if (!(rate > 0)) throw err('qt-audio-rate');                      // > 65535 Hz needs a v2 entry
    var esds = null, ext = walk(ev, 36, entry.length);
    for (var i = 0; i < ext.length; i++) {
        if (ext[i].type === 'esds') esds = entry.subarray(ext[i].start, ext[i].start + ext[i].size);
        else if (ext[i].type !== 'btrt') throw err('qt-audio-entry');
    }
    if (!esds) throw err('qt-audio-entry');
    var head = new Uint8Array(20), hv = new DataView(head.buffer);   // SampleEntry + SoundDescription v1
    hv.setUint16(6, dataRef);
    hv.setUint16(8, 1);                 // version 1 (revision 0, vendor 0)
    hv.setUint16(16, channels);
    hv.setUint16(18, 16);               // sample size
    var tail = new Uint8Array(24), tv = new DataView(tail.buffer);
    tv.setUint16(0, 0xFFFE);            // compression id −2: variable-rate compressed
    tv.setUint32(4, rate * 65536);      // 16.16
    tv.setUint32(8, samplesPerPacket);
    tv.setUint32(20, 2);                // bytes per sample
    var wave = box('wave', [box('frma', [asciiBytes('mp4a')]), box('mp4a', [new Uint8Array(4)]), esds, u32Bytes(8, 0)]);
    var chan = fullBox('chan', 0, 0, u32Bytes(QT_CHANNEL_LAYOUT[channels], 0, 0));
    return box('mp4a', [head, tail, wave, chan]);
}

/* The m4a's soun trak rebuilt for a QuickTime movie. Returns a standalone
   buffer holding just that trak, described the same way loadMoov describes. */
function quickTimeSoundTrak(src, dv, trak) {
    var tk = walk(dv, trak.start + trak.hdr, trak.start + trak.size);
    var mdia = find(tk, 'mdia');
    if (!mdia) throw err('audio-trak-shape');
    var mk = walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size);
    var mdhd = find(mk, 'mdhd'), minf = find(mk, 'minf');
    if (!mdhd || !minf) throw err('audio-trak-shape');
    var nk = walk(dv, minf.start + minf.hdr, minf.start + minf.size);
    var stbl = find(nk, 'stbl');
    if (!stbl) throw err('audio-trak-shape');
    var sk = walk(dv, stbl.start + stbl.hdr, stbl.start + stbl.size);
    var stsd = find(sk, 'stsd'), stts = find(sk, 'stts');
    if (!stsd || !stts) throw err('audio-trak-shape');
    if (dv.getUint32(stsd.start + stsd.hdr + 4) !== 1) throw err('qt-audio-entry');
    var entries = walk(dv, stsd.start + stsd.hdr + 8, stsd.start + stsd.size);
    if (entries.length !== 1) throw err('qt-audio-entry');
    // samples per packet = one AAC frame, read from the track itself (mdhd ticks → samples)
    var ts = mdhdTimescale(dv, mdhd), rate = dv.getUint32(entries[0].start + 32) >>> 16;
    var delta = dv.getUint32(stts.start + stts.hdr + 12);
    var spp = Math.round(delta * rate / (ts || rate));
    if (!(spp > 0 && spp <= 8192)) throw err('qt-audio-entry');
    var slice = function (b) { return src.subarray(b.start, b.start + b.size); };

    var stblKids = sk.map(function (b) {
        return b === stsd ? fullBox('stsd', 0, 0, concatBytes([u32Bytes(1), qtSoundEntry(slice(entries[0]), spp)])) : slice(b);
    });
    var minfKids = [], hasDataHandler = !!find(nk, 'hdlr');
    for (var i = 0; i < nk.length; i++) {
        minfKids.push(nk[i] === stbl ? box('stbl', stblKids) : slice(nk[i]));
        if (nk[i].type === 'smhd' && !hasDataHandler) minfKids.push(qtHandler('dhlr', 'url ', 'DataHandler'));
    }
    var mdiaKids = mk.map(function (b) {
        if (b === minf) return box('minf', minfKids);
        if (b.type === 'hdlr') return qtHandler('mhlr', 'soun', 'SoundHandler');
        return slice(b);
    });
    var trakKids = tk.map(function (b) { return b === mdia ? box('mdia', mdiaKids) : slice(b); });
    var out = box('trak', trakKids);
    var odv = new DataView(out.buffer);
    return { buf: out.buffer, dv: odv, trak: describeTrak(odv, { type: 'trak', start: 0, size: out.length, hdr: 8 }) };
}

/* retime(file, speed, opts) -> { blob, k, timescale:[from,to], fps:[from,to], durationSec, ms, ... }
 *
 * The PICTURE of an mp4-family video played `speed` times faster (> 1) or
 * slower (< 1) without decoding, encoding or moving one sample byte (09.11.2026,
 * /video-speed). Every time in a trak is counted in its media clock — the
 * `mdhd` timescale — so a speed change is a change of that clock: frames,
 * their order, their composition offsets, the B-frame delay all stay what
 * they are, and play in 1/speed of the time. The re-encode lane of the same
 * tool decoded and re-encoded every frame for this (a 3 h 20 min lecture: 36
 * min of VP9 software encode on the reporter's machine, bug report
 * 1000000032), and every re-encode is a generation of loss.
 *
 * Only the picture travels (keepHandlers ['vide'] — sound is re-stretched by
 * the caller and put back with replaceAudio; a timecode or metadata trak would
 * keep the old clock). opts.keepOtherTracks: the caller is about to replace
 * the sound anyway (replaceAudio drops every `soun` trak) — the moov of the
 * file itself is patched and NO layout pass happens here, so the only one is
 * replaceAudio's. Measured on a 3 h 22 min 144p lecture whose sound weighs as
 * much as its picture and is interleaved with every frame: dropping the sound
 * here made 224 282 file.slice() parts (the 25 % dead-byte budget cannot merge
 * them), ~0.17 ms each on Chrome's main thread — twice, with replaceAudio. A
 * trak other than picture and sound refuses in this mode (retime-tracks).
 * opts.overheadBudget / maxParts go to remux(). The trak is patched IN PLACE,
 * sizes unchanged:
 *   · the clock gets an integer factor k first when timescale × speed is not
 *     whole (15360 × 1.17): stts deltas, ctts offsets, the edit's media_time
 *     and the mdhd duration × k — then mdhd.timescale = timescale × k × speed;
 *   · edit segment_durations (movie clock) ÷ speed, tkhd and mvhd durations
 *     follow.
 * Refusals (.remuxReason; the caller re-encodes instead): all of remux()'s, and
 * retime-speed, retime-tracks (not exactly one picture trak), retime-fragmented
 * (a picture-only fragmented file — nothing to flatten through), retime-edts
 * (an edit at a rate other than 1), retime-cslg, retime-overflow (a 32-bit
 * field would not hold the scaled value), retime-fps (a speed-up past
 * opts.maxFps — default 60.5 — needs frames dropped, which is encoding work).
 */
async function retime(file, speed, opts) {
    opts = opts || {};
    var clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
    var t0 = clock.now();
    speed = +speed;
    if (!(speed > 0) || !isFinite(speed)) throw err('retime-speed');
    if (!looksSupported(file)) throw err('not-mp4-family');
    var given = file, src = null, dropped = 0, keepOthers = !!opts.keepOtherTracks;
    if (keepOthers) src = await settled(file);
    else {
        try {
            var ro = { keepHandlers: ['vide'] };
            if (typeof opts.overheadBudget === 'number') ro.overheadBudget = opts.overheadBudget;
            if (opts.maxParts) ro.maxParts = opts.maxParts;
            var r = await remux(file, ro);
            src = new File([r.blob], (file.name || 'video.mp4'), { type: file.type || 'video/mp4' });
            dropped = (r.dropped || []).length;
        } catch (e) {
            if (!e || e.remuxReason !== 'nothing-to-drop') throw e;
            src = await settled(file);
        }
    }
    var V = await loadMoov(src);
    if (V.flattened && keepOthers) {
        // A fragmented file has no moov to patch in place: the ordinary way —
        // remux() flattens it while it drops the other traks.
        return retime(given, speed, Object.assign({}, opts, { keepOtherTracks: false }));
    }
    if (V.flattened) throw err('retime-fragmented');
    var vide = [];
    for (var i = 0; i < V.traks.length; i++) {
        var h = V.traks[i].handler;
        if (h === 'vide') vide.push(V.traks[i]);
        else if (!keepOthers || h !== 'soun') throw err('retime-tracks');
    }
    if (vide.length !== 1) throw err('retime-tracks');
    var dv = V.dv, trak = vide[0].box;
    var tk = walk(dv, trak.start + trak.hdr, trak.start + trak.size);
    var tkhd = find(tk, 'tkhd'), mdia = find(tk, 'mdia'), edts = find(tk, 'edts');
    if (!tkhd || !mdia) throw err('retime-tracks');
    var mk = walk(dv, mdia.start + mdia.hdr, mdia.start + mdia.size);
    var mdhd = find(mk, 'mdhd'), minf = find(mk, 'minf');
    var stbl = minf ? find(walk(dv, minf.start + minf.hdr, minf.start + minf.size), 'stbl') : null;
    if (!mdhd || !stbl) throw err('retime-tracks');
    var sk = walk(dv, stbl.start + stbl.hdr, stbl.start + stbl.size);
    if (find(sk, 'cslg')) throw err('retime-cslg');
    var stts = find(sk, 'stts'), ctts = find(sk, 'ctts'), stsz = find(sk, 'stsz') || find(sk, 'stz2');
    if (!stts) throw err('unsupported-sample-table');

    var U32 = 4294967295;
    var mdV = fullBoxVersion(dv, mdhd), mdP = mdhd.start + mdhd.hdr + 4;
    var tsAt = mdV === 1 ? mdP + 16 : mdP + 8, durAt = mdV === 1 ? mdP + 20 : mdP + 12;
    var T = dv.getUint32(tsAt), mediaDur = mdV === 1 ? u64(dv, durAt) : dv.getUint32(durAt);
    if (!(T > 0) || !(mediaDur > 0)) throw err('retime-tracks');

    // The smallest k that makes the new clock whole (speeds come in hundredths).
    var k = 1;
    while (k <= 1000 && Math.abs(T * k * speed - Math.round(T * k * speed)) > 1e-6) k++;
    if (k > 1000) throw err('retime-speed');
    var T2 = Math.round(T * k * speed);
    if (T2 < 1 || T * k > U32 || T2 > U32) throw err('retime-overflow');

    // Frame rate before and after — a speed-up past maxFps needs frames dropped.
    var nSamples = stsz ? dv.getUint32(stsz.start + stsz.hdr + 8) : 0;
    var fpsIn = nSamples > 0 ? nSamples / (mediaDur / T) : 0;
    var fpsOut = fpsIn * speed;
    var maxFps = +opts.maxFps > 0 ? +opts.maxFps : 60.5;
    if (speed > 1 && fpsOut > maxFps) throw err('retime-fps');

    // Everything below writes into a copy of the moov; nothing has been written yet.
    var buf = V.buf.slice(0), w = new DataView(buf);
    function scaleU32(at) { var v = w.getUint32(at) * k; if (v > U32) throw err('retime-overflow'); w.setUint32(at, v); }
    if (k > 1) {
        // stts: version/flags(4) count(4) {sample_count(4) delta(4)}*
        var sp = stts.start + stts.hdr + 4, sn = dv.getUint32(sp); sp += 4;
        for (var e = 0; e < sn; e++, sp += 8) scaleU32(sp + 4);
        if (ctts) {
            var cv = fullBoxVersion(dv, ctts), cp = ctts.start + ctts.hdr + 4, cn = dv.getUint32(cp); cp += 4;
            for (var c = 0; c < cn; c++, cp += 8) {
                if (cv === 1) { var so = dv.getInt32(cp + 4) * k; if (so > 2147483647 || so < -2147483648) throw err('retime-overflow'); w.setInt32(cp + 4, so); }
                else scaleU32(cp + 4);
            }
        }
        if (mdV === 1) { var md2 = mediaDur * k; w.setUint32(durAt, Math.floor(md2 / 4294967296)); w.setUint32(durAt + 4, md2 >>> 0); }
        else scaleU32(durAt);
    }
    w.setUint32(tsAt, T2);

    var mvhd = find(V.kids, 'mvhd');
    if (!mvhd) throw err('retime-tracks');
    var movieTs = mvhdTimescale(dv, mvhd);
    var presMovie = Math.round(mediaDur / (T * speed) * movieTs);
    if (edts) {
        var elst = find(walk(dv, edts.start + edts.hdr, edts.start + edts.size), 'elst');
        if (elst) {
            var ev = fullBoxVersion(dv, elst), ep = elst.start + elst.hdr + 4, en = dv.getUint32(ep), sum = 0;
            ep += 4;
            for (var x = 0; x < en; x++) {
                var seg, mt, segNew, rateAt;
                if (ev === 1) {
                    seg = u64(dv, ep); mt = dv.getInt32(ep + 8) * 4294967296 + dv.getUint32(ep + 12); rateAt = ep + 16;
                } else { seg = dv.getUint32(ep); mt = dv.getInt32(ep + 4); rateAt = ep + 8; }
                if (mt !== -1 && (dv.getInt16(rateAt) !== 1 || dv.getInt16(rateAt + 2) !== 0)) throw err('retime-edts');
                segNew = Math.round(seg / speed);
                if (ev === 1) {
                    w.setUint32(ep, Math.floor(segNew / 4294967296)); w.setUint32(ep + 4, segNew >>> 0);
                    if (mt > 0 && k > 1) { var m2 = mt * k; w.setInt32(ep + 8, Math.floor(m2 / 4294967296)); w.setUint32(ep + 12, m2 >>> 0); }
                    ep += 20;
                } else {
                    if (segNew > U32) throw err('retime-overflow');
                    w.setUint32(ep, segNew);
                    if (mt > 0 && k > 1) { var m3 = mt * k; if (m3 > 2147483647) throw err('retime-overflow'); w.setInt32(ep + 4, m3); }
                    ep += 12;
                }
                sum += segNew;
            }
            presMovie = sum;
        }
    }
    function setDur(box, v0At, v1At) {
        var v = fullBoxVersion(dv, box), p = box.start + box.hdr + 4 + (v === 1 ? v1At : v0At);
        if (v === 1) { w.setUint32(p, Math.floor(presMovie / 4294967296)); w.setUint32(p + 4, presMovie >>> 0); }
        else { if (presMovie > U32) throw err('retime-overflow'); w.setUint32(p, presMovie); }
    }
    setDur(tkhd, 16, 24);        // tkhd: v0 creation modification id reserved | duration; v1 the same widened
    setDur(mvhd, 12, 20);        // mvhd: v0 creation modification timescale | duration
    var start = V.moovBox.start, end = V.moovBox.start + V.moovBox.size;
    var blob = new Blob([src.slice(0, start), new Uint8Array(buf), src.slice(end)], { type: src.type || 'video/mp4' });
    return {
        blob: blob, speed: speed, k: k, timescale: [T, T2], fps: [fpsIn, fpsOut], dropped: dropped,
        durationSec: presMovie / movieTs, durable: src !== given, ms: Math.round(clock.now() - t0)
    };
}

/* replaceAudio(videoFile, audioFile, opts) -> { blob, ms, parts, ... }
 *
 * The soundtrack of an mp4-family video swapped for the audio track of a
 * second mp4-family file (an .m4a) — again without moving a sample byte
 * through JS. Every `soun` trak of the video is dropped, every other trak is
 * kept verbatim, and the audio file's single `soun` trak is spliced into the
 * video's moov with exactly three things rewritten inside it: its track_ID
 * (the next free one), its tkhd duration (re-expressed in THIS movie's
 * timescale — tkhd counts in movie ticks, and the two files' mvhd timescales
 * need not agree), and its chunk offsets. The video's mvhd next_track_ID is
 * bumped so it stays above every id in the file. Nothing is re-serialised.
 *
 * Why (2026-09-12, /video-volume report #2371): re-encoding only the
 * soundtrack is the whole job of that tool, and the copy remux that follows a
 * native AAC encode was the last place the 43 MB still went through the wasm
 * heap — measured 3.1 s at 4× CPU throttle for a two-input `-c copy`, and it
 * scales with the file, up to the 2 GiB buffer wall. Here the video bytes are
 * file.slice() references and the cost is the part count.
 *
 * The audio trak's edit list (FFmpeg's AAC priming) travels re-expressed in
 * this movie's clock — see «The soundtrack's edit list» above. The picture's
 * B-frame delay moves out of its edit list into its samples (ISO destinations;
 * opts.videoDelayAtZero:false keeps the trak verbatim) — «The picture's
 * B-frame delay»; `videoDelay` in the result says what moved.
 *
 * Refusals (thrown with .remuxReason, caller falls back to FFmpeg): all of
 * remux()'s, plus audio-no-track, audio-edts (an edit list of a shape other
 * than plain edits at rate 1 and empty edits), audio-tref, audio-trak-shape.
 */
async function replaceAudio(videoFile, audioFile, opts) {
    opts = opts || {};
    var clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
    var t0 = clock.now();
    if (!looksSupported(videoFile)) throw err('not-mp4-family');
    var givenVideo = videoFile;
    videoFile = await settled(videoFile);
    var V = await loadMoov(videoFile);
    var Aud = await loadMoov(audioFile);
    var i;

    var keep = [], drop = [];
    for (i = 0; i < V.traks.length; i++) (V.traks[i].handler === 'soun' ? drop : keep).push(V.traks[i]);
    var described = dropDescribers(keep, drop);
    if (!keep.length) throw err('no-tracks-left');
    var droppedIds = {}, maxId = 0;
    for (i = 0; i < drop.length; i++) droppedIds[drop[i].id] = 1;
    for (i = 0; i < keep.length; i++) {
        for (var r = 0; r < keep[i].refIds.length; r++) if (droppedIds[keep[i].refIds[r]]) throw err('tref-dangling');
        if (keep[i].id > maxId) maxId = keep[i].id;
    }
    for (i = 0; i < drop.length; i++) if (drop[i].id > maxId) maxId = drop[i].id;
    var newId = maxId + 1;

    var aTrak = null;
    for (i = 0; i < Aud.traks.length; i++) if (Aud.traks[i].handler === 'soun') { aTrak = Aud.traks[i]; break; }
    if (!aTrak) throw err('audio-no-track');
    var aClock = trakClocks(Aud.dv, aTrak.box);    // refuses tref before anything is rebuilt
    /* The m4a's edit list and the clock it counts in, read before any rebuild
       replaces the buffer (see «The soundtrack's edit list»). */
    var srcEdits = readElst(Aud.dv, aTrak.box);
    var aMvhd = find(Aud.kids, 'mvhd');
    var srcMovieTs = aMvhd ? mvhdTimescale(Aud.dv, aMvhd) : 0;
    /* A QuickTime movie gets the trak in QuickTime form (see «QuickTime
       destination» above); from here on the trak is read from that buffer. */
    var quickTime = await isQuickTimeMovie(videoFile, V.ftypBox);
    if (quickTime) {
        var qt = quickTimeSoundTrak(new Uint8Array(Aud.buf), Aud.dv, aTrak.box);
        Aud = { buf: qt.buf, dv: qt.dv };
        aTrak = qt.trak;
        aClock = trakClocks(Aud.dv, aTrak.box);
    }
    var vMvhd = find(V.kids, 'mvhd');
    if (!vMvhd) throw err('no-mvhd');
    var mvVer = V.dv.getUint8(vMvhd.start + vMvhd.hdr), mvP = vMvhd.start + vMvhd.hdr + 4;
    var movieTs = mvVer === 1 ? V.dv.getUint32(mvP + 16) : V.dv.getUint32(mvP + 8);
    if (!(movieTs > 0) || !(aClock.timescale > 0)) throw err('audio-trak-shape');
    var edits = planEdits(srcEdits, srcMovieTs, movieTs);
    var editTicks = 0;
    if (edits) {
        var ed = trakWithEdits(new Uint8Array(Aud.buf), Aud.dv, aTrak.box, edits);
        Aud = { buf: ed.buf, dv: ed.dv };
        aTrak = ed.trak;
        aClock = trakClocks(Aud.dv, aTrak.box);
        editTicks = ed.ticks;
    }

    /* The kept tracks' samples from the video file, the soundtrack's from the
       audio file. Two sources, one mdat: video parts first. */
    var maxParts = opts.maxParts || 2000;
    var overheadBudget = typeof opts.overheadBudget === 'number' ? opts.overheadBudget : 0.25;
    var srcV = new Uint8Array(V.buf), vEntries = [], keepAt = {}, dropAt = {};
    var vDelay = { zeroMs: 0, keptMs: 0, pendingMs: 0 };
    for (i = 0; i < keep.length; i++) {
        var kb = srcV.subarray(keep[i].box.start, keep[i].box.start + keep[i].box.size);
        /* The picture's B-frame delay goes into its samples (see «The
           picture's B-frame delay» above) — ISO destinations only; for the
           first picture track the result says how much moved, how much of a
           source cut stays behind the edit list, and what a QuickTime movie kept. */
        if (keep[i].handler === 'vide') {
            var vd = videoDelayAtZero(kb, opts.videoDelayAtZero !== false && !quickTime);
            kb = vd.bytes;
            if (!vDelay.zeroMs && !vDelay.pendingMs) vDelay = vd;
        }
        var ve = trakEntry(kb, videoFile);
        vEntries.push(ve);
        keepAt[keep[i].box.start] = ve;
    }
    if (!vEntries.some(function (x) { return x.ranges.length > 0; })) throw err('unsupported-sample-table');
    for (i = 0; i < drop.length; i++) dropAt[drop[i].box.start] = 1;
    var aEntry = trakEntry(new Uint8Array(Aud.buf, aTrak.box.start, aTrak.box.size), audioFile);
    if (!aEntry.ranges.length) throw err('audio-no-track');
    // the foreign trak's duration in OUR movie ticks (with an edit list, the
    // presentation length it describes — trakWithEdits wrote the same)
    var durTicks = edits ? editTicks : Math.round(aClock.duration / aClock.timescale * movieTs);

    /* New moov = video moov header + kept children, with the audio trak
       inserted after the last kept trak (before udta and friends). */
    var pieces = [], lastTrak = -1;
    /* opts.udta(bytes|null) → a moov-level udta box to write instead of the
       source's (or in addition, when it has none): the caller's metadata —
       /video-dubbing's machine-readable «AI-generated» mark (ai-mark.js
       udtaWithMark), which its FFmpeg mux wrote as `-metadata comment=` and
       which a remux that copies udta verbatim would otherwise drop. Part of
       the moov before any chunk offset is computed, so the moov's new size
       moves the mdat consistently. A hook that returns nothing keeps the
       source's udta. */
    var udtaHook = typeof opts.udta === 'function' ? opts.udta : null, udtaOut = '';
    // mvhd.next_track_ID is the last field of the box in both versions
    var nextIdFix = function (dv2, at) { dv2.setUint32(at + vMvhd.size - 4, newId + 1); };
    for (i = 0; i < V.kids.length; i++) {
        var k = V.kids[i];
        if (dropAt[k.start]) continue;
        if (udtaHook && !udtaOut && k.type === 'udta') {
            var ub = udtaHook(srcV.subarray(k.start, k.start + k.size));
            if (ub && ub.length >= 8) { pieces.push({ bytes: ub }); udtaOut = 'replaced'; continue; }
        }
        if (keepAt[k.start]) { pieces.push({ trak: keepAt[k.start] }); lastTrak = pieces.length - 1; continue; }
        pieces.push(k === vMvhd ? { bytes: srcV.subarray(k.start, k.start + k.size), fix: nextIdFix }
                                : { bytes: srcV.subarray(k.start, k.start + k.size) });
    }
    if (udtaHook && !udtaOut) {
        var nb = udtaHook(null);
        if (nb && nb.length >= 8) { pieces.push({ bytes: nb }); udtaOut = 'appended'; }
    }
    // the foreign trak: its id and its duration, read where they sit in its
    // FINAL bytes (the writer may have widened its chunk-offset table)
    var aPiece = { trak: aEntry, fix: function (dv2, at) {
        var c = trakClocks(aEntry.dv, aEntry.desc.box);
        dv2.setUint32(at + c.idAt, newId);
        if (c.durWide) {
            dv2.setUint32(at + c.durAt, Math.floor(durTicks / 4294967296));
            dv2.setUint32(at + c.durAt + 4, durTicks >>> 0);
        } else {
            dv2.setUint32(at + c.durAt, Math.min(4294967295, durTicks));
        }
    } };
    if (lastTrak >= 0) pieces.splice(lastTrak + 1, 0, aPiece); else pieces.push(aPiece);

    var out = writeFile({
        ftyp: V.ftypBox ? videoFile.slice(V.ftypBox.start, V.ftypBox.start + V.ftypBox.size) : null,
        ftypLen: V.ftypBox ? V.ftypBox.size : 0,
        pieces: pieces,
        groups: [
            { file: videoFile, traks: vEntries, maxParts: maxParts },
            { file: audioFile, traks: [aEntry], maxParts: Math.max(64, maxParts >> 2) }
        ],
        overheadBudget: overheadBudget,
        mime: opts.mime || videoFile.type || 'video/mp4'
    });
    return {
        blob: out.blob,
        ms: Math.round(clock.now() - t0),
        parts: out.parts,
        waste: out.waste,
        kept: keep.map(function (t) { return t.handler; }),
        dropped: drop.map(function (t) { return t.handler; }),
        audioTrackId: newId,
        quickTime: quickTime,
        edits: edits ? edits.length : 0,
        durable: videoFile !== givenVideo,
        flattened: !!V.flattened,
        udta: udtaOut || 'kept',
        co64: out.widened,
        described: described,
        // the picture's B-frame delay: ms moved into the samples · ms of a
        // source cut still behind its edit list · ms a QuickTime movie kept
        videoDelay: { zeroMs: vDelay.zeroMs, keptMs: vDelay.keptMs, qtMs: vDelay.pendingMs }
    };
}

/* inspection ------------------------------------------------------------- */

/* ffmpeg's codec names, because that is what callers already key off: the
   probe path they are replacing returned "Video: h264" / "Audio: aac" and
   tools built their CODEC_EXT tables on those spellings. Unknown fourccs come
   back lowercased and raw, which is what an ffmpeg log would show too. */
var CODEC_NAME = {
    avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
    av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4', 's263: ': 'h263', jpeg: 'mjpeg',
    'ap4h': 'prores', 'apch': 'prores', 'apcn': 'prores', 'apcs': 'prores', 'apco': 'prores',
    mp4a: 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3', alac: 'alac', Opus: 'opus', fLaC: 'flac',
    samr: 'amr_nb', sawb: 'amr_wb', sowt: 'pcm_s16le', twos: 'pcm_s16be',
    lpcm: 'pcm_s16le', 'in24': 'pcm_s24le', 'ulaw': 'pcm_mulaw', 'alaw': 'pcm_alaw',
    '.mp3': 'mp3', 'ms\u0000U': 'mp3'
};

/* Everything the FFmpeg probe was being loaded for — codec names, geometry,
   duration — read straight out of the moov we already have to parse. Reading
   it costs one slice of a few hundred KB instead of a 32 MB wasm core.
   Same failure contract as remux(): throws a named reason, caller falls back. */
async function inspect(file) {
    if (!looksSupported(file)) throw err('not-mp4-family');
    var top = await topLevel(file);
    var moovBox = find(top, 'moov');
    if (!moovBox) throw err('no-moov');
    if (moovBox.size > MOOV_MAX) throw err('moov-too-large');

    var dv = new DataView(await file.slice(moovBox.start, moovBox.start + moovBox.size).arrayBuffer());
    var kids = walk(dv, moovBox.hdr, moovBox.size);
    var out = { tracks: [], durationSec: 0, fragmented: !!find(kids, 'mvex') };

    var mvhd = find(kids, 'mvhd'), movieTs = 0;
    if (mvhd) {
        var p = mvhd.start + mvhd.hdr, v = dv.getUint8(p);
        var ts = v === 1 ? dv.getUint32(p + 4 + 16) : dv.getUint32(p + 4 + 8);
        var du = v === 1 ? u64(dv, p + 4 + 20)      : dv.getUint32(p + 4 + 12);
        if (ts > 0) out.durationSec = du / ts;
        movieTs = ts;
    }
    for (var i = 0; i < kids.length; i++) {
        if (kids[i].type !== 'trak') continue;
        var t = describeTrak(dv, kids[i]);
        var rec = { handler: t.handler, codec: '', width: 0, height: 0, startSec: trackStartSec(dv, kids[i], movieTs) };
        var sd = t.stbl && t.stbl.stsd;
        if (sd && dv.getUint32(sd.start + sd.hdr + 4) > 0) {
            var entry = sd.start + sd.hdr + 8;                  // past version+flags + entry_count
            var fmt = fourcc(dv, entry + 4);
            rec.codec = CODEC_NAME[fmt] || fmt.toLowerCase().replace(/[^\w.]/g, '');
            if (t.handler === 'vide') {
                /* VisualSampleEntry: 8 box header + 8 SampleEntry (6 reserved
                   + data_reference_index) + 16 (pre_defined/reserved) = 32. */
                rec.width = dv.getUint16(entry + 32);
                rec.height = dv.getUint16(entry + 34);
            }
        }
        out.tracks.push(rec);
    }
    if (!out.tracks.length) throw err('no-tracks');
    return out;
}

/* Where the video's OWN sound starts on the movie's clock, in seconds — the
   one thing no decoder says. WebCodecs, decodeAudioData and FFmpeg-to-WAV all
   hand back the track from its first presented sample, and the movie plays
   that sample this much after the picture starts (trackStartSec: the leading
   empty edits). So a soundtrack built on the DECODED sound must be put back
   this late, or it plays early by exactly that much — measured 01.10.2026 on
   a fixture whose sound starts 0.478 s in: /video-dubbing's mux and
   VideoAudioLane (/video-volume) both returned it 478 ms early.
   0 = starts with the picture, not mp4-family, no sound or unknown. One read
   of the moov per file (cached). */
var soundStartCache = typeof WeakMap === 'function' ? new WeakMap() : null;
async function soundStart(file) {
    if (!file || !looksSupported(file)) return 0;
    if (soundStartCache && soundStartCache.has(file)) return soundStartCache.get(file);
    var s = 0;
    try {
        var ins = await inspect(file);
        for (var i = 0; i < ins.tracks.length; i++) {
            if (ins.tracks[i].handler !== 'soun') continue;
            var v = ins.tracks[i].startSec;
            if (typeof v === 'number' && isFinite(v) && v > 0) s = v;
            break;
        }
    } catch (e) { s = 0; }
    if (soundStartCache) soundStartCache.set(file, s);
    return s;
}

window.MP4TrackRemux = {
    looksSupported: looksSupported,
    inspect: inspect,
    soundStart: soundStart,
    remux: remux,
    retime: retime,
    replaceAudio: replaceAudio,
    dropAudio: function (file, opts) {
        var o = {};
        for (var k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
        o.dropHandlers = ['soun'];
        return remux(file, o);
    }
};
})();
