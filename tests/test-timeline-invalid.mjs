import assert from 'node:assert/strict';
import {mountPrecisionTimeline} from '../js/precision-timeline.js';
import {mountSubtitleTimeline,adjustCue} from '../js/subtitle-timeline.js';
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.classList={toggle(){}};}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(){}
 removeEventListener(){}
 remove(){}
}
globalThis.document={createElement:tag=>new Element(tag)};
const all=node=>[node,...node.children.flatMap(all)];
const lane=mountPrecisionTimeline(new Element('host'),{duration:10});
lane.setRange(8,2);
const nodes=all(lane.root);
assert.equal(nodes.find(node=>node.dataset.trim==='start').value,'00:00:02.000');
assert.equal(nodes.find(node=>node.dataset.trim==='end').value,'00:00:08.000');
lane.setDuration(Infinity);lane.setPlayhead(Infinity);lane.zoomTo(NaN);
for(const node of all(lane.root))assert.ok(!/NaN|Infinity/.test(JSON.stringify(node.style)));
const subtitles=mountSubtitleTimeline(new Element('host'));
subtitles.render([{start:0,end:1},{start:1,end:2,text:null},{start:2,end:3,text:'Текст'}]);
const labels=all(subtitles.root).map(node=>node.attributes['aria-label']).filter(Boolean);
assert.ok(labels.includes('Реплика 1: '));
assert.ok(labels.includes('Реплика 3: Текст'));
for(const cue of [{start:NaN,end:2},{start:0,end:Infinity},{start:3,end:2},{start:-1,end:2}]){
 for(const part of ['start','end','move'])assert.equal(adjustCue([cue],0,part,1),null);
}
console.log('PASS timeline DOM: ordered ranges, finite geometry, absent cue text and malformed cue edits');
