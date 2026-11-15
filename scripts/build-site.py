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
# This strip is rendered at 60 fps over 16 seconds: its slow motion is baked in.
# Slowing the older 48 fps stage clip in the browser loses visible smoothness.
for extension in ('jpg', 'mp4'):
    source = prototype / 'assets' / 'motion' / 'glyph' / f'home.{extension}'
    shutil.copyfile(source, assets / f'glyph.{extension}')
(out / '.nojekyll').touch()
print(out)
