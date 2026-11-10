/*
 * subtitle-serializer.js — shared SRT/VTT/plain serializer, the OUTPUT
 * companion to subtitle-parser.js (which only PARSES). Operates on the same
 * cue shape: { start, end, text, speaker? } with start/end in SECONDS.
 *
 * Extracted 2026-07-05 to kill two byte-identical inline copies (the
 * speech-to-text blade's exportSRT/VTT and auto-captions' srtTime/vttTime) and
 * to fix a real bug they shared: they faked each cue's END as the NEXT cue's
 * start (or start+5s for the last), so any gap between segments left a subtitle
 * hanging on screen. The transcription engines actually provide the real end
 * (whisper.cpp offsets.to; transformers.js chunk.timestamp[1]) — this serializer
 * uses it, with a defensive fallback only when a cue truly lacks an end.
 *
 * window.SubtitleSerializer.toSrt(cues, opts) / .toVtt(cues, opts)
 *   opts.speakers  — prefix each cue with its speaker (SRT "[Name] ", VTT "<v Name>")
 *   opts.maxGap    — (unused placeholder for future subtitle-refine)
 */
(function () {
    'use strict';

    function pad(n, w) { n = String(Math.max(0, Math.floor(n))); while (n.length < w) n = '0' + n; return n; }

    /* seconds → "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT) */
    function fmt(sec, sepMs) {
        sec = Math.max(0, Number(sec) || 0);
        /* Whole milliseconds first. The carry that used to sit here moved a
           rounded-up 1000 ms into the seconds alone, so 59.9996 s came out as
           "00:00:60,000" — an invalid timing a player drops with its cue. */
        var total = Math.round(sec * 1000);
        var h = Math.floor(total / 3600000);
        var m = Math.floor(total % 3600000 / 60000);
        var s = Math.floor(total % 60000 / 1000);
        var ms = total % 1000;
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sepMs + pad(ms, 3);
    }
    function srtTime(sec) { return fmt(sec, ','); }
    function vttTime(sec) { return fmt(sec, '.'); }

    /* Normalise a cue array: coerce start/end, resolve a missing/invalid end
       from the next cue's start (minus a hair) or a short default, and enforce
       start < end and non-overlap so players don't choke. Returns a fresh array. */
    function normalize(cues) {
        var out = [];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i] || {};
            var text = (c.text == null ? '' : String(c.text)).trim();
            if (!text) continue;
            var start = Number(c.start);
            if (!isFinite(start) || start < 0) start = out.length ? out[out.length - 1].end : 0;
            var end = Number(c.end);
            out.push({ start: start, end: (isFinite(end) ? end : NaN), text: text, speaker: c.speaker });
        }
        for (var j = 0; j < out.length; j++) {
            var cur = out[j], nxt = out[j + 1];
            if (!isFinite(cur.end) || cur.end <= cur.start) {
                /* real end missing — fall back to just-before-next, else +2.5s */
                cur.end = nxt ? Math.max(cur.start + 0.3, nxt.start - 0.05) : cur.start + 2.5;
            }
            /* never overlap the next cue */
            if (nxt && isFinite(nxt.start) && cur.end > nxt.start) cur.end = Math.max(cur.start + 0.2, nxt.start);
        }
        return out;
    }

    function label(text, speaker, kind) {
        if (!speaker) return text;
        return kind === 'vtt' ? ('<v ' + speaker + '>' + text) : ('[' + speaker + '] ' + text);
    }

    function toSrt(cues, opts) {
        opts = opts || {};
        var n = normalize(cues || []);
        var out = '';
        for (var i = 0; i < n.length; i++) {
            out += (i + 1) + '\n';
            out += srtTime(n[i].start) + ' --> ' + srtTime(n[i].end) + '\n';
            out += label(n[i].text, opts.speakers ? n[i].speaker : null, 'srt') + '\n\n';
        }
        return out.trim() + '\n';
    }

    function toVtt(cues, opts) {
        opts = opts || {};
        var n = normalize(cues || []);
        var out = 'WEBVTT\n\n';
        for (var i = 0; i < n.length; i++) {
            out += vttTime(n[i].start) + ' --> ' + vttTime(n[i].end) + '\n';
            out += label(n[i].text, opts.speakers ? n[i].speaker : null, 'vtt') + '\n\n';
        }
        return out.trim() + '\n';
    }

    var API = { toSrt: toSrt, toVtt: toVtt, srtTime: srtTime, vttTime: vttTime, normalize: normalize };
    if (typeof window !== 'undefined') window.SubtitleSerializer = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
