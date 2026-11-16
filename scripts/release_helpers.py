"""Build-only manifest for runtime helper resources and their packaged verification."""
import ast
from pathlib import Path
import re
import shutil


HELPERS = (
    'workspace_terminal.py', 'terminal_replay.py', 'session_observer.py', 'tasktap_shell.py', 'observers',
    'claude_desktop.py', 'session_activity.py', 'project_sessions.py',
    'visible_session.py', 'session_lifecycle.py', 'terminal_hosts.py',
    'extra_terminals.py', 'cmux_host.py', 'router-provider', 'worker_usage.py',
    'ask-user', 'agent-tools', 'run-agent',
    'cmux-sessions', 'cmux_sessions.py', 'desktop_sessions.py', 'kokoro-voice',
    'session_models.py',
)


def helper_files(root):
    scripts = Path(root)/'scripts'
    files = {}
    for name in HELPERS:
        source = scripts/name
        assert source.exists(), f'Missing helper source: {source}'
        entries = sorted(source.rglob('*')) if source.is_dir() else [source]
        for entry in entries:
            if entry.is_file() and entry.name != '.DS_Store' and '__pycache__' not in entry.parts and entry.suffix not in ('.pyc', '.pyo'):
                files[entry.relative_to(scripts)] = entry
    return files


def verify_dependencies(root, files):
    scripts = Path(root)/'scripts'
    for relative, source in files.items():
        text = source.read_text()
        if source.suffix == '.py' or text.startswith('#!/usr/bin/env python'):
            for node in ast.walk(ast.parse(text, filename=str(source))):
                modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
                for module in modules:
                    local = Path(module.split('.')[0]+'.py')
                    if (scripts/local).is_file():
                        assert local in files, f'Unbundled helper dependency: {relative} imports {local}'
        elif source.suffix == '.mjs':
            for reference in re.findall(r'''\bfrom\s+['"](\.[^'"]+)['"]''', text):
                dependency = (source.parent/reference).resolve().relative_to(scripts.resolve())
                assert dependency in files, f'Unbundled observer dependency: {relative} imports {dependency}'


def copy_helpers(root, resources):
    resources = Path(resources)
    files = helper_files(root)
    verify_dependencies(root, files)
    # Retire removed observer modules when an existing build directory is reused.
    observers = resources/'observers'
    if observers.exists():
        shutil.rmtree(observers)
    bytecode = resources/'__pycache__'
    if bytecode.exists():
        shutil.rmtree(bytecode)
    for relative, source in files.items():
        destination = resources/relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def verify_helpers(root, resources):
    resources = Path(resources)
    files = helper_files(root)
    verify_dependencies(root, files)
    for relative, source in files.items():
        packaged = resources/relative
        assert packaged.is_file(), f'Missing bundled helper: {relative}'
        assert packaged.read_bytes() == source.read_bytes(), f'Stale bundled helper: {relative}'
        if source.stat().st_mode & 0o111:
            assert packaged.stat().st_mode & 0o111, f'Bundled helper is not executable: {relative}'
    observer_files = {p.relative_to(resources) for p in (resources/'observers').rglob('*')
                      if p.is_file() and p.name != '.DS_Store' and '__pycache__' not in p.parts}
    assert observer_files == {p for p in files if p.parts[0] == 'observers'}, 'Unexpected bundled observer resources'
    return len(files)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['copy', 'verify'])
    parser.add_argument('resources', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.action == 'copy':
        copy_helpers(root, args.resources)
    else:
        print(f'{verify_helpers(root, args.resources)} helper resources verified, including nested observers.')
