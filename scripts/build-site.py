"""Build the GitHub Pages artifact with the same artwork and motion curve as the app."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'build' / 'pages'
if out.exists():
    shutil.rmtree(out)
shutil.copytree(root / 'site', out)
assets = out / 'assets'
for source, name in [('motion-scale.js','motion-scale.js'), ('assets/motion/glyph/stage.jpg','glyph.jpg'),
                     ('assets/motion/glyph/stage.mp4','glyph.mp4')]:
    shutil.copyfile(root / 'prototype' / source, assets / name)
(out / '.nojekyll').touch()
print(out)
