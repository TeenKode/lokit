import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
const ensure=workflow.split('      - name: Ensure FFmpeg and FFprobe\n')[1]?.split('      - name: ')[0];
assert.ok(ensure,'FFmpeg setup step must exist');
assert.match(ensure,/ffmpeg -version \| sed -n '1p'/);
assert.match(ensure,/ffprobe -version \| sed -n '1p'/);
assert.doesNotMatch(ensure,/\|\s*head\s+-n\s+1/,'head exits early and can fail bash pipefail with SIGPIPE');
console.log('CI FFmpeg setup: no early-closing version pipeline — PASS');
