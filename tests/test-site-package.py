"""Pages and ZIP releases must include every editor entry and runtime asset."""
import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_site', ROOT / 'scripts/prepare-site.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp) / 'source'
    root.mkdir()
    for path in ['index.html', 'pdf.html', 'craft.html', 'analytics.html', 'about.html',
                 'batch.html', 'craft.css', 'pdf.css', 'sw.js', '.nojekyll',
                 'manifest.webmanifest', 'THIRD_PARTY_LICENSES.md', 'THIRD_PARTY_COMPONENTS.md',
                 'icons/icon.svg', 'js/craft-loader.js', 'assets/codecs/manifest.json',
                 'pdfcraft/index.html', 'pdfcraft/offline-assets.json', 'pdfcraft/NOTICE',
                 'pdfcraft/LICENSE-MIT', 'pdfcraft/LICENSE-APACHE',
                 'craft-apps/photocraft/index.html', 'craft-apps/photocraft/lokit-assets.json']:
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('fixture')
    (root / 'artcraft-releases.json').write_text(json.dumps({'apps': [{'name': 'photocraft'}]}))
    (root / 'private-config.txt').write_text('not public')
    output = module.prepare_site(root, Path(temp) / 'output')
    for name in ['craft.html', 'pdf.html', 'craft.css', 'pdf.css',
                 'craft-apps/photocraft/index.html', 'pdfcraft/index.html',
                 'js/craft-loader.js', 'artcraft-releases.json', 'THIRD_PARTY_LICENSES.md']:
        assert (output / name).is_file(), name
    assert not (output / 'private-config.txt').exists()
    try:
        module.prepare_site(root, output)
        raise AssertionError('Must not overwrite existing output')
    except ValueError:
        pass
    (root / 'craft-apps/photocraft/index.html').unlink()
    try:
        module.prepare_site(root, Path(temp) / 'incomplete')
        raise AssertionError('Must reject missing editor before packaging')
    except ValueError as error:
        assert 'photocraft/index.html' in str(error)
    assert not (Path(temp) / 'incomplete').exists()
for name in ('deploy-pages.yml', 'release.yml'):
    workflow = (ROOT / '.github/workflows' / name).read_text()
    assert 'python scripts/prepare-site.py' in workflow
    assert 'python scripts/vendor-artcraft.py --workers 3' in workflow
    assert 'python scripts/vendor-pdfcraft.py' in workflow
print('PASS complete site packaging, public files, missing-editor rejection and workflow parity')
