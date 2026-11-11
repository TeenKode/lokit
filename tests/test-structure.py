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
for page in ['index.html','analytics.html','about.html','batch.html']:
 parser=HTMLChecks();parser.feed((ROOT/page).read_text())
 for name in parser.links:
  file=ROOT/name.removeprefix('./')
  assert file.exists(),(page,name)
 if page=='about.html':
  used=set()
 else:
  code=(ROOT/'js' / ('app.js' if page=='index.html' else 'batch-page.js' if page=='batch.html' else 'analytics-page.js')).read_text()
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
for page in ['index.html','analytics.html','about.html','batch.html']:
 html=(ROOT/page).read_text()
 assert 'class="version-pill"' in html
 assert f'v{v}' in html
 assert './style-enhancements.css' in html
 assert './layout-compact.css' in html
assert f'lokit-v{v}' in sw
assert "'./about.html'" in sw
assert "'./js/version.js'" in sw
for asset in ['js/render.js','js/mp4-fast.js','js/vendor/mp4-track-remux.js','js/vendor/mp4-flatten.js','js/vendor/mp4-copy-trim.js','js/vendor/webm-copy-trim.js','js/presets.js','style-enhancements.css','layout-compact.css']:
 assert (ROOT/asset).is_file(),asset
 assert "'./"+asset+"'" in sw,asset
assert not (ROOT/'js/analytics-config.js').exists()
print('Version, offline cache, shared renderer and settings — PASS')

for asset in ['batch.html','batch.css','js/batch-page.js','js/batch-queue.js','js/zip.js']:
 assert (ROOT/asset).exists(),asset
 assert f"'./{asset}'" in sw,asset

from html.parser import HTMLParser
page=(ROOT/'batch.html').read_text()
selectors=set(re.findall(r"\$\('([a-z0-9-]+)'\)",(ROOT/'js/batch-page.js').read_text()))
parser=HTMLChecks();parser.feed(page)
assert selectors <= parser.ids,('batch.html','missing IDs',selectors-parser.ids)
assert 'batch.html' in (ROOT/'index.html').read_text()
print('Batch UI selectors, navigation and PWA cache — PASS')

for path in ['js/experimental-engines.js','js/experimental-ffmpeg-worker.js']:
 assert (ROOT/path).is_file(),path
 assert f"'./{path}'" in sw,path
for page in ['index.html','batch.html']:
 html=(ROOT/page).read_text()
 assert 'https://cdn.jsdelivr.net' in html and 'wasm-unsafe-eval' in html
print('Optional engines, strict opt-in assets and CSP — PASS')

# The grouped tool menu must be a first-class offline asset.
home=(ROOT/'index.html').read_text()
assert 'id="tool-sidebar"' in home and 'id="sidebar-toggle"' in home
assert 'id="tool-grid"' in home and 'id="categories"' in home
assert './sidebar.css' in home
assert "'./sidebar.css'" in sw
assert (ROOT/'tests/test-sidebar.py').exists()
print('Grouped sidebar, mobile drawer and offline assets — PASS')
