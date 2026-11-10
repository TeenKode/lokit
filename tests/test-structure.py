from html.parser import HTMLParser
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
class HTMLChecks(HTMLParser):
 def __init__(self): super().__init__();self.ids=set();self.links=[]
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if 'id' in attrs:
   if attrs['id'] in self.ids:raise AssertionError('Duplicate id: '+attrs['id'])
   self.ids.add(attrs['id'])
  for attr in ('src','href'):
   if attr in attrs and attrs[attr].startswith('./'):
    self.links.append(attrs[attr].split('#')[0])
for page in ['index.html','analytics.html','about.html']:
 parser=HTMLChecks();parser.feed((ROOT/page).read_text())
 for name in parser.links:
  file=ROOT/name.removeprefix('./')
  assert file.exists(),(page,name)
 if page=='about.html':
  used=set()
 else:
  code=(ROOT/'js' / ('app.js' if page=='index.html' else 'analytics-page.js')).read_text()
  used=set(re.findall(r"\$\(['\"]#([a-zA-Z0-9-]+)['\"]\)",code))
  assert used <= parser.ids | ({'file-preview'} if page=='index.html' else set()), (page,'missing ids',used-parser.ids)
 print(page,'valid references',len(parser.links),'IDs',len(parser.ids),'JS references',len(used))
sw=(ROOT/'sw.js').read_text()
for name in re.findall(r"'\./([^']+)'",sw):
 assert (ROOT/name).exists(),name
assert re.search(r"lokit-v\d+",sw)
for name in ['analytics.js','analytics-page.js','app.js','media.js','tools.js','editor.js','version.js']:
 assert (ROOT/'js'/name).exists()
assert not (ROOT/'analytics-worker').exists()
assert not (ROOT/'js/analytics-config.js').exists()
for name in ['trim-timeline.js','subtitle-serializer.js','waveform-preview.js']:
 assert (ROOT/'js'/'vendor'/name).exists(),name
for forbidden in ['timbrica','тимбрика','utilitarium','утилитарий']:
 for file in ROOT.glob('*.html'):
  assert forbidden not in file.read_text().lower(),(file,forbidden)
print('Structure tests: HTML links, IDs, frontend selectors, PWA cache assets, local analytics, branding — PASS')

# Версия проверяется динамически, без хардкода.
version=(ROOT/'js/version.js').read_text()
found=re.search(r"APP_VERSION\s*=\s*['\"](\d+\.\d+\.\d+)['\"]",version)
assert found,'No APP_VERSION'
v=found.group(1)
for page in ['index.html','analytics.html','about.html']:
 html=(ROOT/page).read_text()
 assert 'class="version-pill"' in html
 assert f'v{v}' in html
 assert './style-enhancements.css' in html
assert f'lokit-v{v}' in sw
assert "'./about.html'" in sw
assert "'./js/version.js'" in sw
for asset in ['js/render.js','js/presets.js','style-enhancements.css']:
 assert (ROOT/asset).is_file(),asset
 assert "'./"+asset+"'" in sw,asset
assert not (ROOT/'js/analytics-config.js').exists()
print('Version, offline cache, shared renderer and settings — PASS')
