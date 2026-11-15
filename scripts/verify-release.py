"""Validate a local release's archive, public signature, metadata and packaged source."""
import hashlib
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
release = Path(sys.argv[1]).resolve()
ns = {'sparkle': 'http://www.andymatuschak.org/xml-namespaces/sparkle'}
item = ET.parse(release/'appcast.xml').find('./channel/item')
enc = item.find('enclosure')
archive = release/enc.attrib['url'].rsplit('/', 1)[-1]
assert archive.stat().st_size == int(enc.attrib['length'])
checksums = dict(line.split()[::-1] for line in (release/'SHA256SUMS').read_text().splitlines())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksums[archive.name]
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    subprocess.run(['ditto', '-x', '-k', str(archive), str(tmp)], check=True)
    app = tmp/'Tasktap.app'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'io.github.harzerheribert.tasktap'
    assert info['CFBundleVersion'] == item.find('sparkle:version', ns).text
    assert info['CFBundleShortVersionString'] == item.find('sparkle:shortVersionString', ns).text
    assert info['SUVerifyUpdateBeforeExtraction'] is True
    assert info['SUAllowsAutomaticUpdates'] is False
    assert enc.attrib['url'].startswith('https://github.com/HarzerHeribert/Tasktap/releases/download/v'+info['CFBundleShortVersionString']+'/')
    resources = app/'Contents/Resources'
    for source in (root/'prototype').rglob('*'):
        if source.is_file() and source.name != '.DS_Store':
            packaged = resources/'prototype'/source.relative_to(root/'prototype')
            assert packaged.is_file(), f'Missing packaged interface file: {source}'
            assert packaged.read_bytes() == source.read_bytes(), f'Stale packaged interface file: {source}'
    for source in (root/'scripts').iterdir():
        packaged = resources/source.name
        if source.is_file() and packaged.is_file():
            assert packaged.read_bytes() == source.read_bytes(), f'Stale bundled helper: {source}'
    assert (resources/'workspace_terminal.py').is_file()
    assert (resources/'LICENSE').read_bytes() == (root/'LICENSE').read_bytes()
    assert (resources/'Sparkle-LICENSE').read_bytes() == (root/'build/sparkle/LICENSE').read_bytes()
    for name in ('xterm', 'addon-fit', 'addon-search', 'marked', 'purify'):
        assert (resources/'prototype/vendor'/f'{name}-LICENSE').stat().st_size > 0
    assert subprocess.check_output(['lipo', '-archs', str(app/'Contents/MacOS/Tasktap')], text=True).strip() == 'arm64'
    subprocess.run(['swiftc', '-module-cache-path', str(tmp/'module-cache'), str(root/'scripts/verify-release.swift'), '-o', str(tmp/'verify')], check=True)
    subprocess.run([str(tmp/'verify'), str(archive), enc.attrib['{'+ns['sparkle']+'}edSignature'], info['SUPublicEDKey']], check=True)
print('Archive checksum, bundle signature, feed metadata, full packaged interface, helpers and third-party notices verified.')
