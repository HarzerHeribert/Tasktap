"""Build the GitHub Pages site with the app's wide glyph wave."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'build' / 'pages'
if out.exists():
    shutil.rmtree(out)
shutil.copytree(root / 'site', out)
assets = out / 'assets'
prototype = root / 'prototype'
shutil.copyfile(prototype / 'motion-scale.js', assets / 'motion-scale.js')
for extension in ('jpg', 'mp4'):
    source = prototype / 'assets' / 'motion' / 'glyph' / f'stage.{extension}'
    shutil.copyfile(source, assets / f'glyph.{extension}')
(out / '.nojekyll').touch()
print(out)
