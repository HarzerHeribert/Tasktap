"""Build the GitHub Pages product site, documentation and bundled app artwork."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'build' / 'pages'
if out.exists():
    shutil.rmtree(out)
for name in ('agents-native.jpg', 'result.png', 'result-mobile.png', 'capture.png', 'review.png', 'review-mobile.png', 'regions.js', 'question.png', 'appearance.png'):
    if not (root / 'site' / 'assets' / 'product' / name).is_file():
        instruction = 'Capture the installed Mac app with real agent sessions.' if name.startswith('agents') else 'Run scripts/capture-product.cjs.'
        raise FileNotFoundError(f'Missing product screenshot: {name}. {instruction}')
for artwork in ('glyph',):
    for extension in ('jpg', 'mp4', 'mobile.mp4'):
        name = f'{artwork}-mobile.mp4' if extension == 'mobile.mp4' else f'{artwork}.{extension}'
        if not (root / 'site' / 'assets' / 'motion' / name).is_file():
            raise FileNotFoundError(f'Missing site artwork: {name}. Run scripts/render-site-motion.cjs.')
shutil.copytree(root / 'site', out)
(out / '.nojekyll').touch()
print(out)
