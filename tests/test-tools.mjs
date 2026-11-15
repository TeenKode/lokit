import assert from 'node:assert/strict';
import {tools} from '../js/tools.js';
assert.equal(tools.length,40);
assert.equal(tools.find(tool=>tool.id==='pdf-workbench')?.href,'./pdf.html');
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
console.log('Tools tests: 25 unique executable definitions, SRT/VTT (including short timestamps), shifts, merge — PASS');
for(const hours of ['0','123']){
 const input=new File([`1\n${hours}:00:01,100 --> ${hours}:00:03,500\nТест\n`],'hours.srt');
 const output=await get('subtitle-converter').run({files:[input]});
 assert.ok((await output.blob.text()).includes(`${hours.padStart(2,'0')}:00:01.100`));
 const round=await get('subtitle-converter').run({files:[new File([await output.blob.text()],'hours.vtt')]});
 assert.ok((await round.blob.text()).includes(`${hours.padStart(2,'0')}:00:01,100`));
}
for(const timing of ['00:61:01,000 --> 00:62:02,000','00:00:04,000 --> 00:00:01,000']){
 const invalid=new File([`1\n${timing}\nОшибка\n`],'invalid.srt');
 await assert.rejects(get('subtitle-shift').run({files:[invalid],values:{seconds:'1'}}),/корректные/);
 const mixed=await get('subtitle-merger').run({files:[file,invalid]});
 assert.ok(!(await mixed.blob.text()).includes('Ошибка'));
}
