"""Build the GitHub Pages site (the product page and the guide) into build/pages.

The site is static. What it takes from the app (site/app: the live notch, the chrome, the token file and the pictures)
is made on a Mac by scripts/render-site.cjs and committed, so what is published is what was looked at; this script
copies the site and refuses to publish it incomplete or with anything private in it.
"""
from pathlib import Path
import re
import shutil
import sys

root = Path(__file__).resolve().parents[1]
site = root / 'site'
out = root / 'build' / 'pages'
# The install lines' scripts (site/install.sh, site/install.ps1), published as they are and as a .txt copy to read.
SCRIPTS = ('install.sh', 'install.ps1')

# Everything the pages name must be there: a picture or a script that is missing fails here, not on the public site.
missing = []
for page in (site / 'index.html', site / 'docs' / 'index.html', site / 'app' / 'notch.html'):
    if not page.is_file():
        missing.append(str(page.relative_to(root)))
        continue
    text = page.read_text()
    names = re.findall(r'(?:src|href)="([^"#]+)"', text)
    for group in re.findall(r'srcset="([^"]+)"', text):
        names += [part.split()[0] for part in group.split(',')]
    for name in names:
        if re.match(r'[a-z]+:', name):
            continue
        target = (page.parent / name)
        if name.endswith('/'):
            target = target / 'index.html'
        if not target.exists() and name not in [f'{s}.txt' for s in SCRIPTS]:
            missing.append(f'{page.relative_to(root)} names {name}')
for name in ('stage.js', 'chrome.js', 'tokens.css'):
    if not (site / 'app' / name).is_file():
        missing.append(f'site/app/{name}')
for name in SCRIPTS:
    if not (site / name).is_file():
        missing.append(f'site/{name}')
if missing:
    sys.exit('The site is incomplete. Run: (cd ui && npm run build) && node scripts/render-site.cjs\n  ' + '\n  '.join(missing))

# Nothing from a person's machine: the only home folder a published file may name is the fixtures' invented one.
private = re.compile(r'/Users/(?!example/)[^\s"\'<>]*|/private/tmp/[^\s"\'<>]*|/home/[a-z][^\s"\'<>]*|[\w.-]+/\.claude/')
found = []
for file in sorted(site.rglob('*')):
    if file.is_file() and file.suffix in ('.html', '.css', '.js', '.ts', '.json', '.svg', '.txt', '.xml', '.md', '.sh', '.ps1', ''):
        for hit in private.findall(file.read_text(errors='replace')):
            found.append(f'{file.relative_to(root)}: {hit}')
if found:
    sys.exit('A private path would be published:\n  ' + '\n  '.join(found[:20]))

# The app's values and the site's copy of them should not drift apart. A warning, not a failure: the pictures are
# made on a Mac and looked at before they are committed.
if (root / 'ui/src/tokens.css').read_bytes() != (site / 'app/tokens.css').read_bytes():
    print('::warning::site/app/tokens.css differs from ui/src/tokens.css: the site shows an older look. Run scripts/render-site.cjs on a Mac and look at the result.')

if out.exists():
    shutil.rmtree(out)
# site/src holds what site/app is made from; it is not part of the site.
shutil.copytree(site, out, ignore=shutil.ignore_patterns('src', '.DS_Store'))
(out / '.nojekyll').touch()
# The install lines' scripts are served as they are; GitHub Pages gives .sh and .ps1 a type a browser downloads, so a
# copy of each as .txt is what the page links for reading.
for name in SCRIPTS:
    shutil.copyfile(site / name, out / f'{name}.txt')
print(out)
