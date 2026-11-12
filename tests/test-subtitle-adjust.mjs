import assert from 'node:assert/strict';
import {adjustCue} from '../js/subtitle-timeline.js';

const valid=[{start:1,end:3,text:'Hello'}];
assert.deepEqual(adjustCue(valid,0,'move',4),{start:4,end:6,text:'Hello'});
assert.deepEqual(adjustCue(valid,0,'start',2),{start:2,end:3,text:'Hello'});
assert.deepEqual(adjustCue(valid,0,'end',4),{start:1,end:4,text:'Hello'});
for(const cue of [
  {start:NaN,end:3},
  {start:1,end:Infinity},
  {start:-1,end:3},
  {start:3,end:1},
  {start:2,end:2},
  {start:undefined,end:3}
]) {
  assert.equal(adjustCue([cue],0,'move',4),null,'Invalid cue timing must not propagate to edits');
}
assert.equal(adjustCue(valid,0,'move',Infinity),null);
assert.deepEqual(valid,[{start:1,end:3,text:'Hello'}],'Original cue must remain unchanged');
console.log('Subtitle cue timing validation: PASS');
