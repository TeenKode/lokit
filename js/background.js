// Deterministic, one-shot SVG backgrounds. No canvas, animation, timers or network.
const DAY_MS = 86_400_000;
const STORAGE_KEY = 'lokit.background.v1';
const THEME_NAMES = Object.freeze([
  ['aurora', 'Северное свечение'],
  ['topography', 'Топографические линии'],
  ['constellations', 'Цифровые созвездия'],
  ['flow', 'Потоки данных'],
  ['lenses', 'Стеклянные линзы'],
  ['geometry', 'Геометрическая сеть'],
  ['dust', 'Цифровая пыль'],
  ['interference', 'Интерференционные волны'],
  ['polygons', 'Полигональный туман'],
]);
export const BACKGROUND_OPTIONS = Object.freeze([
  ['auto', 'Авто · ежедневно'],
  ...THEME_NAMES,
  ['none', 'Без фона'],
]);
export const BACKGROUND_THEMES = Object.freeze(THEME_NAMES.map(([key]) => key));

function generator(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function seedFor(theme, timestamp) {
  let hash = Math.floor(timestamp / DAY_MS) >>> 0;
  for (const char of theme) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash || 1;
}

export function resolveBackgroundTheme(choice, timestamp = Date.now()) {
  if (choice === 'none' || BACKGROUND_THEMES.includes(choice)) return choice;
  // The same theme on every page during a UTC day; changes only on a new day.
  return BACKGROUND_THEMES[Math.floor(timestamp / DAY_MS) % BACKGROUND_THEMES.length];
}

export function generateAuroraPositions(timestamp = Date.now()) {
  const random = generator(seedFor('aurora', timestamp));
  const ranges = [[8,30,-12,14],[69,96,-9,22],[4,35,68,107],[64,96,66,109]];
  return ranges.map(([minX,maxX,minY,maxY]) => ({
    x: Math.round(minX + (maxX-minX)*random()),
    y: Math.round(minY + (maxY-minY)*random()),
  }));
}

export function applyAurora(element, timestamp = Date.now()) {
  if (!element) return;
  generateAuroraPositions(timestamp).forEach(({x,y},index) => {
    const key = 'abcd'[index];
    element.style.setProperty('--aurora-' + key + '-x', x + '%');
    element.style.setProperty('--aurora-' + key + '-y', y + '%');
  });
}

function svg(inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900">' + inner + '</svg>';
}
function f(value) { return Number(value).toFixed(1); }

export function generateBackgroundSvg(theme, timestamp = Date.now()) {
  if (!BACKGROUND_THEMES.includes(theme) || theme === 'aurora') return '';
  const random = generator(seedFor(theme, timestamp));
  const shapes = [];
  if (theme === 'topography') {
    // Shared phase prevents adjacent contours from crossing like random scribbles.
    const phase = random() * 6.283;
    const ridgeX = 1030 + random() * 220;
    for (let row = 0; row < 29; row++) {
      let d = '';
      for (let x = -30; x <= 1470; x += 30) {
        const y = 25 + row * 31 + Math.sin(x / 205 + phase + row * .025) * 16
          + Math.sin(x / 360 + row * .09) * 14
          + 36 * Math.exp(-Math.pow((x - ridgeX) / 305, 2)) * Math.cos(row * .20);
        d += (x === -30 ? 'M' : 'L') + x + ' ' + f(y);
      }
      const color = row % 7 === 0 ? '#7b9df0' : '#7ec8ec';
      shapes.push('<path d="' + d + '" stroke="' + color + '" opacity="' + f(.17 + random() * .08) + '"/>');
    }
    return svg('<g fill="none" stroke-width="1">' + shapes.join('') + '</g>');
  }
  if (theme === 'constellations') {
    const points = Array.from({length:54}, () => [Math.round(random()*1440),Math.round(random()*900)]);
    for (let i=0;i<points.length;i++) {
      const [x,y] = points[i];
      const nearest = points.map(([xx,yy],j) => ({j,dist:Math.hypot(xx-x,yy-y)}))
        .filter(p => p.j !== i && p.dist < 170).sort((a,b)=>a.dist-b.dist).slice(0,2);
      for (const {j} of nearest) if (j>i)
        shapes.push('<path d="M'+x+' '+y+'L'+points[j][0]+' '+points[j][1]+'" stroke="#70b8ef" stroke-width=".8" opacity=".24"/>');
      shapes.push('<circle cx="'+x+'" cy="'+y+'" r="'+f(.9+random()*1.45)+'" fill="#b3ddff" opacity="'+f(.36+random()*.42)+'"/>');
    }
    return svg(shapes.join(''));
  }
  if (theme === 'flow') {
    const bend = (random() - .5) * 90;
    for (let i = 0; i < 21; i++) {
      // Close, parallel Bezier ribbons create a single intentional flow.
      const y = 165 + i * 27;
      const offset = (random() - .5) * 10;
      const d = 'M-90 ' + f(y) + ' C310 ' + f(y - 125 + bend + offset)
        + ' 890 ' + f(y + 100 + bend * .55) + ' 1530 ' + f(y - 72 + offset);
      shapes.push('<path d="' + d + '" stroke="' + (i % 5 === 0 ? '#68dad0' : '#80b5f3')
        + '" stroke-width="' + f(.8 + random() * .45) + '" opacity="' + f(.18 + random() * .12) + '" fill="none"/>');
    }
    return svg(shapes.join(''));
  }
  if (theme === 'lenses') {
    // Sparse concentric lenses with negative space between them.
    const anchors = [[120,200],[1330,160],[130,790],[1270,780],[690,480]];
    anchors.forEach(([ax,ay],i) => {
      const cx = ax + Math.round((random() - .5) * 125);
      const cy = ay + Math.round((random() - .5) * 90);
      const rx = 125 + Math.round(random() * 110);
      const ry = 100 + Math.round(random() * 85);
      const color = i % 2 ? '#ab8ee9' : '#70cad5';
      for (let ring = 0; ring < 3; ring++) {
        const scale = 1 + ring * .27;
        shapes.push('<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + f(rx * scale)
          + '" ry="' + f(ry * scale) + '" fill="' + color + '" fill-opacity="'
          + (ring === 0 ? '.055' : '.008') + '" stroke="' + color
          + '" stroke-opacity="' + (ring === 0 ? '.24' : '.11') + '" stroke-width=".9"/>');
      }
    });
    return svg(shapes.join(''));
  }
  if (theme === 'geometry' || theme === 'polygons') {
    const cols = theme === 'geometry' ? 15 : 13;
    const rows = theme === 'geometry' ? 9 : 8;
    const dx = 1440 / (cols - 1), dy = 900 / (rows - 1);
    const nodes=Array.from({length:rows},(_,y) =>
      Array.from({length:cols},(_,x)=>[
        Math.round(x*dx+(x===0||x===cols-1?0:(random()-.5)*30)),
        Math.round(y*dy+(y===0||y===rows-1?0:(random()-.5)*30))
      ]));
    const polygon = (a,b,c,i) => {
      const points=[a,b,c].map(([x,y])=>x+','+y).join(' ');
      if (theme==='geometry') return '<polygon points="'+points+'" fill="'+(i%7===0?'#70bdf6':'none')+'" fill-opacity=".055" stroke="#7ab4df" stroke-opacity=".19" stroke-width=".9"/>';
      const tones=['#4f94c7','#7773c9','#38a7a9','#8675c0'];
      return '<polygon points="'+points+'" fill="'+tones[i%tones.length]+'" fill-opacity="'+f(.075+random()*.09)+'"/>';
    };
    let n=0;
    for(let y=0;y<rows-1;y++)for(let x=0;x<cols-1;x++) {
      const a=nodes[y][x],b=nodes[y][x+1],c=nodes[y+1][x],d=nodes[y+1][x+1];
      shapes.push(polygon(a,b,c,n++),polygon(b,c,d,n++));
    }
    return svg(shapes.join(''));
  }
  if (theme === 'dust') {
    for(let i=0;i<148;i++) {
      const x=Math.round(random()*1440), y=Math.round(random()*900);
      shapes.push('<circle cx="'+x+'" cy="'+y+'" r="'+f(.6+random()*1.35)
        +'" fill="'+(i%5===0?'#7fe2d5':'#a1cff7')
        +'" opacity="'+f(.22+random()*.40)+'"/>');
    }
    return svg(shapes.join(''));
  }
  if (theme === 'interference') {
    for(const [cx,cy] of [[-75,240],[1505,360],[715,980]]) {
      const shift=random()*35;
      for(let i=0;i<24;i++) {
        const rx=60+i*24+shift, ry=44+i*18+shift;
        shapes.push('<ellipse cx="'+cx+'" cy="'+cy+'" rx="'+f(rx)+'" ry="'+f(ry)+'" fill="none" stroke="'+(i%3===0?'#a58bf1':'#82b7f2')+'" stroke-opacity=".19" stroke-width=".85"/>');
      }
    }
    return svg(shapes.join(''));
  }
  return '';
}

export function applyBackground(element, choice = 'auto', timestamp = Date.now()) {
  if (!element) return 'none';
  const theme = resolveBackgroundTheme(choice, timestamp);
  element.dataset.backgroundTheme = theme;
  if (theme === 'none' || theme === 'aurora') {
    element.style.removeProperty('--lokit-pattern');
  } else {
    const markup = generateBackgroundSvg(theme, timestamp);
    element.style.setProperty('--lokit-pattern', 'url("data:image/svg+xml,' + encodeURIComponent(markup) + '")');
  }
  if (theme === 'aurora') applyAurora(element, timestamp);
  return theme;
}

function readChoice(storage) {
  try {
    const choice=storage.getItem(STORAGE_KEY);
    return BACKGROUND_OPTIONS.some(([key])=>key===choice) ? choice : 'auto';
  } catch { return 'auto'; }
}

export function initBackground(doc = document, storage = localStorage, timestamp = Date.now()) {
  const backdrop=doc.querySelector('.page-glow');
  const slot=doc.querySelector('[data-background-control]');
  const choice=readChoice(storage);
  applyBackground(backdrop,choice,timestamp);
  if (!slot) return;
  const label=doc.createElement('label');
  label.className='background-control';
  label.textContent='Фон';
  const select=doc.createElement('select');
  select.id='background-choice';
  select.setAttribute('aria-label','Оформление фона');
  for(const [key,name] of BACKGROUND_OPTIONS) {
    const option=doc.createElement('option');
    option.value=key;
    option.textContent=name;
    select.append(option);
  }
  label.append(select);
  slot.replaceChildren(label);
  select.value=choice;
  select.addEventListener('change',() => {
    applyBackground(backdrop,select.value,Date.now());
    try { storage.setItem(STORAGE_KEY,select.value); } catch { /* Private browsing can deny storage. */ }
  });
}

if (typeof document !== 'undefined') {
  let storage = null;
  try { storage = window.localStorage; } catch { /* Storage can be disabled. */ }
  initBackground(document,storage);
}
