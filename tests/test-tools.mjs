import assert from 'node:assert/strict';
import {tools} from '../js/tools.js';
assert.equal(tools.length,24);
assert.equal(new Set(tools.map(t=>t.id)).size,tools.length);
for(const tool of tools){
  assert(tool.id && tool.title && tool.description && tool.category && typeof tool.run==='function');
  assert(/^[a-z0-9-]{2,48}$/.test(tool.id));
}
const get=id=>tools.find(t=>t.id===id);
const original='1\n00:00:01,100 --> 00:00:03,500\nПривет, мир!\n';
const file=new File([original],'caption.srt',{type:'text/plain'});
const vtt=await get('subtitle-converter').run({files:[file]});
assert.match(await vtt.blob.text(),/^WEBVTT/);
assert.match(await vtt.blob.text(),/00:00:01\.100 --> 00:00:03\.500/);
const vttShort='WEBVTT\n\n00:02.000 --> 00:05.000\nТест\n';
const converted=await get('subtitle-converter').run({files:[new File([vttShort],'test.vtt') ]});
assert.match(await converted.blob.text(),/00:00:02,000 --> 00:00:05,000/);
const shifted=await get('subtitle-shift').run({files:[file],values:{seconds:'2'}});
assert.match(await shifted.blob.text(),/00:00:03,100 --> 00:00:05,500/);
const merged=await get('subtitle-merger').run({files:[file,new File([original.replace('Привет, мир!','Второй')],'x.srt')]});
assert.match(await merged.blob.text(),/Второй/);

// Invalid minute/second fields and non-positive cue durations are not valid SRT cues.
const invalidClock='1\n00:61:01,000 --> 00:61:03,000\nInvalid minutes\n\n2\n00:00:70,000 --> 00:00:72,000\nInvalid seconds\n\n3\n00:00:05,000 --> 00:00:02,000\nReversed cue\n';
await assert.rejects(
  get('subtitle-shift').run({files:[new File([invalidClock],'invalid.srt')],values:{seconds:'1'}}),
  /Не найдены корректные временные метки SRT/
);
const mixed=await get('subtitle-merger').run({files:[new File([invalidClock+original],'mixed.srt'),file]});
assert.doesNotMatch(await mixed.blob.text(),/Invalid minutes|Invalid seconds|Reversed cue/);
assert.match(await mixed.blob.text(),/Привет, мир!/);

console.log('Tools tests: 24 unique executable definitions, SRT/VTT (including short timestamps), shifts, merge — PASS');
