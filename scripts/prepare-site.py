#!/usr/bin/env python3
"""Build the same complete static site for Pages and downloadable releases."""
import argparse
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def prepare_site(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    # Refuse to overwrite a previous build or copy the source inside itself.
    if (output.exists() or output == root or output in root.parents
            or (root in output.parents and output.parent != root)):
        raise ValueError("Output must be a new directory outside the source ancestors")
    registry = json.loads((root / 'artcraft-releases.json').read_text(encoding='utf-8'))
    required = ['index.html', 'pdf.html', 'craft.html', 'sw.js',
                'manifest.webmanifest', '.nojekyll', 'artcraft-releases.json',
                'pdfcraft/index.html', 'pdfcraft/offline-assets.json',
                'pdfcraft/NOTICE', 'pdfcraft/LICENSE-MIT', 'pdfcraft/LICENSE-APACHE',
                'assets/codecs/manifest.json']
    for app in registry['apps']:
        required.extend(['craft-apps/' + app['name'] + '/' + name
                         for name in ('index.html', 'lokit-assets.json')])
    for name in required:
        if not (root / name).is_file():
            raise ValueError('Missing site resource: ' + name)
    directories = ('icons', 'js', 'assets', 'pdfcraft', 'craft-apps')
    for directory in directories:
        if not (root / directory).is_dir():
            raise ValueError('Missing site directory: ' + directory)
    output.mkdir(parents=True)
    # Only public files are allowlisted; source tests and configuration stay out.
    for file in {*root.glob('*.html'), *root.glob('*.css'),
                 *(root / name for name in ('sw.js', 'manifest.webmanifest',
                   '.nojekyll', 'artcraft-releases.json', 'THIRD_PARTY_LICENSES.md',
                   'THIRD_PARTY_COMPONENTS.md'))}:
        shutil.copy2(file, output / file.name)
    for directory in directories:
        shutil.copytree(root / directory, output / directory)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '_site')
    args = parser.parse_args()
    print('Prepared complete static site:', prepare_site(ROOT, args.output))
