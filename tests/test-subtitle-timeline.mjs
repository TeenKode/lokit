import assert from 'node:assert/strict';
import {mountSubtitleTimeline} from '../js/subtitle-timeline.js';

function element() {
  return {
    children: [], style: {}, classList: {toggle() {}},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    setAttribute(name, value) { (this.attributes ??= {})[name] = value; },
    addEventListener() {}, remove() {}
  };
}
const originalDocument = globalThis.document;
try {
  globalThis.document = {createElement: element};
  const host = element();
  const timeline = mountSubtitleTimeline(host);
  const cues = [
    {start: 0, end: 1},
    {start: 1, end: 2, text: null},
    {start: 2, end: 3, text: 'Hello'}
  ];
  assert.doesNotThrow(() => timeline.render(cues));
  const blocks = timeline.root.children[1].children;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].children[1].textContent, 'Реплика 1');
  assert.equal(blocks[1].children[1].textContent, 'Реплика 2');
  assert.equal(blocks[2].children[1].textContent, 'Hello');
  assert.equal(blocks[0].attributes['aria-label'], 'Реплика 1: ');
  console.log('Subtitle timeline handles missing cue text — PASS');
} finally {
  globalThis.document = originalDocument;
}
