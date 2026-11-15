"""Build the GitHub Pages product site, documentation and bundled app artwork."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'build' / 'pages'
if out.exists():
    shutil.rmtree(out)
for name in ('workspace.png', 'review.png', 'question.png', 'appearance.png'):
    if not (root / 'site' / 'assets' / 'product' / name).is_file():
        raise FileNotFoundError(f'Missing product screenshot: {name}. Run scripts/capture-product.cjs.')
shutil.copytree(root / 'site', out)
assets = out / 'assets'
prototype = root / 'prototype'
shutil.copyfile(prototype / 'motion-scale.js', assets / 'motion-scale.js')
for extension in ('jpg', 'mp4'):
    source = prototype / 'assets' / 'motion' / 'glyph' / f'stage.{extension}'
    shutil.copyfile(source, assets / f'glyph.{extension}')
(out / '.nojekyll').touch()
print(out)
