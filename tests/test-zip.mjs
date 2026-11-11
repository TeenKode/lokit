import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createZip,safeZipName,uniqueZipEntries} from '../js/zip.js';
assert.equal(safeZipName('../hack\\file.txt'),'_hack_file.txt');
assert.equal(safeZipName('report.txt...'),'report.txt');
assert.equal(safeZipName('file. '),'file');
assert.equal(safeZipName('CON'),'_CON');
assert.equal(safeZipName('nul.txt'),'_nul.txt');
assert.equal(safeZipName('LPT9.csv'),'_LPT9.csv');
assert.equal(safeZipName('COM0.txt'),'COM0.txt');
assert.deepEqual(uniqueZipEntries([
  {name:'report.txt.',blob:new Blob([])},
  {name:'report.txt',blob:new Blob([])},
  {name:'NUL.txt',blob:new Blob([])}
]).map(x=>x.name),['report.txt','report (2).txt','_NUL.txt']);
const samples=[
  {name:'пример.srt',blob:new Blob(['привет\n'])},
  {name:'пример.srt',blob:new Blob(['вторая запись\n'])},
  {name:'movie.mp4',blob:new Blob([new Uint8Array([0,0,1,2,3,254,255])])},
  {name:'empty.txt',blob:new Blob([])}
];
const names=uniqueZipEntries(samples).map(x=>x.name);
assert.equal(new Set(names).size,4);
let percent=-1;
const zip=await createZip(samples,{chunkSize:1024,onProgress:x=>{assert(x.percent>=percent);percent=x.percent;}});
assert.equal(zip.type,'application/zip');assert.equal(percent,100);
const dir=mkdtempSync(join(tmpdir(),'lokit-zip-'));
try{
  const filename=join(dir,'test.zip');writeFileSync(filename,new Uint8Array(await zip.arrayBuffer()));
  const code=`import zipfile,sys\np=sys.argv[1]\nwith zipfile.ZipFile(p) as z:\n assert z.testzip() is None\n assert z.namelist()==['пример.srt','пример (2).srt','movie.mp4','empty.txt'],z.namelist()\n assert z.read('пример.srt')=='привет\\n'.encode('utf8')\n assert z.read('пример (2).srt')=='вторая запись\\n'.encode('utf8')\n assert z.read('movie.mp4')==bytes([0,0,1,2,3,254,255])\n assert z.read('empty.txt')==b''`;
  const py=spawnSync('python',['-c',code,filename],{encoding:'utf8'});
  assert.equal(py.status,0,py.stderr||py.stdout);
}finally{rmSync(dir,{recursive:true,force:true});}
const abort=new AbortController();
await assert.rejects(createZip([{name:'large.bin',blob:new Blob([new Uint8Array(1024*8)])}],{signal:abort.signal,chunkSize:1024,onProgress:()=>abort.abort()}),e=>e?.name==='AbortError');
await assert.rejects(createZip([]),/Нет готовых/);
console.log('PASS zip: ZIP32, CRC32, UTF-8, filename collisions, zero-size, binary data, cancel');
