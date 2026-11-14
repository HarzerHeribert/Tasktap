"""Require a reader-visible change to the published guide alongside app changes."""
import argparse
from html.parser import HTMLParser
from pathlib import Path
import subprocess


class GuideText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_article = False
        self.words = []

    def handle_starttag(self, tag, attrs):
        if tag == 'article':
            self.in_article = True
        if self.in_article and tag == 'a':
            self.words.append(dict(attrs).get('href', ''))

    def handle_endtag(self, tag):
        if tag == 'article':
            self.in_article = False

    def handle_data(self, data):
        if self.in_article:
            self.words.extend(data.split())


def visible(html):
    guide = GuideText()
    guide.feed(html)
    return guide.words


def git(*args):
    return subprocess.check_output(['git', *args], text=True)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('base', help='Commit before the push, or PR merge base')
parser.add_argument('head', nargs='?', default='HEAD')
args = parser.parse_args()
doc = 'site/docs/index.html'
changes = git('diff', '--no-renames', '--name-only', '-z', args.base, args.head).split('\0')
def runtime(path):
    if path.startswith(('native/', 'prototype/', 'integrations/')):
        return True
    return path.startswith('scripts/') and not (Path(path).name.startswith(('verify-', 'render-')) or
        path in ('scripts/build-site.py',) or path.startswith('scripts/artwork/'))

if any(map(runtime, changes)):
    previous = subprocess.run(['git','show',f'{args.base}:{doc}'],capture_output=True,text=True)
    current = git('show',f'{args.head}:{doc}')
    if doc not in changes or not visible(current) or visible(previous.stdout) == visible(current):
        raise SystemExit('Update the relevant section of site/docs/index.html alongside the app change. The published guide needs a reader-visible edit.')
print('Documentation coverage passed.')
