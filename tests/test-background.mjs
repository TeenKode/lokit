import assert from 'node:assert/strict';
import {
  BACKGROUND_OPTIONS, BACKGROUND_THEMES, resolveBackgroundTheme,
  generateAuroraPositions, generateBackgroundSvg, applyAurora, applyBackground
} from '../js/background.js';

const today = Date.UTC(2026, 10, 11, 10);
assert.equal(BACKGROUND_THEMES.length, 9);
assert.equal(new Set(BACKGROUND_OPTIONS.map(([key]) => key)).size, 11);
assert.equal(resolveBackgroundTheme('none', today), 'none');
assert.equal(resolveBackgroundTheme('invalid', today), resolveBackgroundTheme('auto', today));
assert.notEqual(resolveBackgroundTheme('auto', today), resolveBackgroundTheme('auto', today + 86_400_000));
for(const theme of BACKGROUND_THEMES) {
  assert.equal(resolveBackgroundTheme(theme, today), theme);
  const first = generateBackgroundSvg(theme, today);
  assert.equal(first, generateBackgroundSvg(theme, today + 60_000),'unstable daily theme: ' + theme);
  if (theme === 'aurora') {
    assert.equal(first, '');
  } else {
    assert.ok(first.startsWith('<svg xmlns='), theme);
    assert.ok(first.endsWith('</svg>'), theme);
    assert.notEqual(first,generateBackgroundSvg(theme,today+86_400_000),theme+' does not regenerate');
    assert.ok(first.length<80_000,theme+' is too large: '+first.length);
    assert.ok(!/<script|<foreignObject|<image/i.test(first),theme);
    assert.ok(!/NaN|Infinity|undefined/.test(first),theme+' has invalid SVG geometry');
    const expected = {
      topography:['<path',29],
      constellations:['<circle',54],
      flow:['<path',21],
      lenses:['<ellipse',15],
      geometry:['<polygon',150],
      dust:['<circle',148],
      interference:['<ellipse',72],
      polygons:['<polygon',160],
    }[theme];
    const count = first.split(expected[0]).length-1;
    assert.ok(count>=expected[1],theme+' unexpectedly sparse: '+count);
  }
}
const aurora=generateAuroraPositions(today);
assert.equal(aurora.length,4);
assert.deepEqual(aurora,generateAuroraPositions(today+60_000));
for(const [index,{x,y}] of aurora.entries()) {
  const [minX,maxX,minY,maxY]=[[8,30,-12,14],[69,96,-9,22],[4,35,68,107],[64,96,66,109]][index];
  assert.ok(x>=minX&&x<=maxX);
  assert.ok(y>=minY&&y<=maxY);
}
const properties = new Map();
const element = {
  dataset:{},
  style:{
    setProperty:(key,value)=>properties.set(key,value),
    removeProperty:key=>properties.delete(key)
  }
};
applyAurora(element,today);
assert.equal(properties.get('--aurora-a-x'),aurora[0].x+'%');
assert.equal(properties.get('--aurora-d-y'),aurora[3].y+'%');
for(const theme of BACKGROUND_THEMES){
  assert.equal(applyBackground(element,theme,today),theme);
  assert.equal(element.dataset.backgroundTheme,theme);
  if(theme!=='aurora') assert.match(properties.get('--lokit-pattern'),/^url\("data:image\/svg\+xml,/);
}
applyBackground(element,'none',today);
assert.equal(element.dataset.backgroundTheme,'none');
assert.ok(!properties.has('--lokit-pattern'));
assert.equal(applyBackground(null,'auto',today),'none');
console.log('Procedural backgrounds: 9 themes, deterministic SVG, disabled mode, CSS properties — PASS');
