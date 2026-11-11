#!/usr/bin/env node
/** Copy pinned npm distributions to the public static website, including GitHub Pages root. */
import {copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const base = resolve(import.meta.dirname, '..');
const dest = resolve(base, 'assets/codecs');
const version = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8')).dependencies;
if (version.mediabunny !== '1.65.2' || version['@ffmpeg/core'] !== '0.12.10')
  throw new Error('Versions in package.json must match the pinned public codec paths');
const files = [
  ['mediabunny/dist/bundles/mediabunny.cjs', 'mediabunny-1.65.2.cjs', 100000],
  ['@ffmpeg/core/dist/umd/ffmpeg-core.js', 'ffmpeg-core-0.12.10.js', 50000],
  ['@ffmpeg/core/dist/umd/ffmpeg-core.wasm', 'ffmpeg-core-0.12.10.wasm', 20000000]
];
mkdirSync(dest, {recursive:true});
const manifest = {version:1, packages:{mediabunny:version.mediabunny, ffmpeg:version['@ffmpeg/core']}, files:[]};
for (const [source, target, minBytes] of files) {
  const file = resolve(base, 'node_modules', source);
  if (!existsSync(file) || statSync(file).size < minBytes) throw new Error('Missing/invalid npm codec: ' + source);
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  copyFileSync(file, resolve(dest,target));
  manifest.files.push({name:target, bytes:bytes.length, sha256});
  console.log(target, (bytes.length/1048576).toFixed(2) + ' MiB', sha256);
}
// Include any license files shipped by the exact npm distributions.
for (const [pkg, output] of [
  ['mediabunny', 'LICENSE-mediabunny.txt'],
  ['@ffmpeg/core', 'LICENSE-ffmpeg-core.txt']
]) {
  const candidates = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING'];
  const source = candidates.map(name=>resolve(base,'node_modules',pkg,name)).find(existsSync);
  if (source) copyFileSync(source,resolve(dest,output));
  else console.warn('License file not packaged for',pkg,'; see THIRD_PARTY_LICENSES.md');
}
writeFileSync(resolve(dest,'THIRD-PARTY-NOTICES.txt'),
  'Lokit optional local codec modules\\n'
  + 'mediabunny 1.65.2 — MPL-2.0 — https://github.com/Vanilagy/mediabunny\\n'
  + '@ffmpeg/core 0.12.10 — GPL-2.0-or-later — https://github.com/ffmpegwasm/ffmpeg.wasm\\n'
  + 'Refer to THIRD_PARTY_LICENSES.md in the Lokit repository for the source and notices.\\n');
writeFileSync(resolve(dest,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
