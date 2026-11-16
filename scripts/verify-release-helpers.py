"""Offline checks for required helper files, nested observers and local dependency closure."""
from pathlib import Path
import tempfile
from release_helpers import copy_helpers, helper_files, verify_helpers, verify_dependencies


root = Path(__file__).resolve().parents[1]


def rejects(action, message):
    try:
        action()
    except AssertionError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError('Accepted '+message)


with tempfile.TemporaryDirectory(prefix='tasktap-release-helpers-') as directory:
    resources = Path(directory)/'Resources'
    copy_helpers(root, resources)
    files = helper_files(root)
    assert verify_helpers(root, resources) == len(files)
    assert Path('observers/emit.mjs') in files
    assert Path('observers/pi.mjs') in files
    assert Path('observers/opencode/index.mjs') in files
    assert Path('observers/opencode/package.json') in files
    # Missing top-level and nested resources must fail, even when every remaining file matches.
    for relative in ('session_observer.py', 'session_lifecycle.py', 'observers/emit.mjs', 'observers/opencode/package.json'):
        packaged = resources/relative
        original = packaged.read_bytes()
        packaged.unlink()
        rejects(lambda: verify_helpers(root, resources), 'Missing bundled helper: '+relative)
        packaged.write_bytes(original)
    for relative in ('visible_session.py', 'observers/opencode/index.mjs'):
        packaged = resources/relative
        original = packaged.read_bytes()
        packaged.write_bytes(original+b'\n# stale packaged content\n')
        rejects(lambda: verify_helpers(root, resources), 'Stale bundled helper: '+relative)
        packaged.write_bytes(original)
    (resources/'observers/retired.mjs').write_text('old module')
    rejects(lambda: verify_helpers(root, resources), 'Unexpected bundled observer resources')
    (resources/'__pycache__').mkdir()
    (resources/'__pycache__/old.pyc').write_bytes(b'old bytecode')
    copy_helpers(root, resources)
    assert not (resources/'observers/retired.mjs').exists()
    assert not (resources/'__pycache__').exists()
    verify_helpers(root, resources)
    # Build-time checks also reject manifest omissions that break helper imports.
    for missing in ('session_lifecycle.py', 'session_observer.py', 'observers/emit.mjs'):
        incomplete = {p: source for p, source in files.items() if p != Path(missing)}
        rejects(lambda: verify_dependencies(root, incomplete), 'Unbundled ')
    executable = resources/'run-agent'
    executable.chmod(0o600)
    rejects(lambda: verify_helpers(root, resources), 'Bundled helper is not executable: run-agent')

print('PASS: required helper manifest, nested observers, missing/stale resources, dependency closure, executable modes and retired-resource cleanup.')
