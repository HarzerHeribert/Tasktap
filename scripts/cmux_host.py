"""Create visible workspaces and focus a saved surface through cmux's public socket CLI."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import time
import uuid


def installed():
    configured = os.environ.get('TASKTAP_TERMINAL_APP')
    bundles = [Path(configured)] if configured else [Path('/Applications/cmux.app'), Path.home()/'Applications/cmux.app']
    for app in bundles:
        command = app/'Contents/Resources/bin/cmux'
        if command.is_file() and os.access(command, os.X_OK):
            return str(command), str(app)
    cli = shutil.which('cmux') if not configured else None
    if not cli:
        raise ValueError('Install cmux or choose another terminal in Preferences → Session models.')
    return cli, 'cmux'


def call(cli, args, timeout=12):
    try:
        return subprocess.run([cli, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ValueError('cmux did not confirm this request. Check the workspace in cmux before trying again.') from None


def unavailable(result):
    message = (result.stderr or result.stdout).strip()
    detail = message.lower()
    if 'only processes started inside cmux' in detail or 'cmux processes only' in detail:
        return ValueError('cmux accepts requests only from processes started in cmux. Quit Tasktap and run its app executable from a cmux terminal, or choose another terminal in Preferences → Session models.')
    if 'password' in detail or 'authentication' in detail or 'access denied' in detail:
        return ValueError('cmux denied socket access. Check the socket access settings in cmux or choose another terminal.')
    return ValueError(message[:400] or 'cmux could not complete the request.')


def missing_socket(result):
    message = result.stderr.lower()
    return any(s in message for s in ('socket not found', 'connection refused', 'no such file or directory', 'socket is not available'))


def require_connection(cli, app):
    result = call(cli, ['ping'], timeout=3)
    if result.returncode == 0:
        return
    # A missing socket is the only reason to launch and wait. Authentication errors
    # refer to a live server and must always be returned as-is.
    if not missing_socket(result):
        raise unavailable(result)
    if os.environ.get('CMUX_SOCKET_PATH'):
        raise ValueError('The configured cmux socket is unavailable. Open its cmux instance or check CMUX_SOCKET_PATH.')
    subprocess.run(['/usr/bin/open', '-g', '-a', app], check=True, capture_output=True, timeout=10)
    deadline = time.monotonic()+4
    while time.monotonic() < deadline:
        time.sleep(.15)
        result = call(cli, ['ping'], timeout=3)
        if result.returncode == 0:
            return
        if not missing_socket(result):
            raise unavailable(result)
    raise ValueError('Open cmux and check that its socket is enabled, or choose another terminal.')


def open_terminal(argv, cwd, title, run_dir):
    cli, app = installed()
    require_connection(cli, app)
    # Use a command on a newly created workspace. No input is sent to any existing shell.
    command = 'exec '+shlex.join([str(value) for value in argv])
    result = call(cli, ['new-workspace', '--name', title, '--cwd', str(cwd),
                        '--command', command, '--focus', 'true'])
    if result.returncode:
        raise unavailable(result)


def focus_terminal(surface):
    cli, app = installed()
    panel = str(uuid.UUID(surface['surface']))
    options = ['--workspace', str(uuid.UUID(surface['workspace']))] if surface.get('workspace') else []
    result = call(cli, ['focus-panel', '--panel', panel, *options])
    if result.returncode:
        raise unavailable(result)
    subprocess.run(['/usr/bin/open', '-a', app], check=True, capture_output=True, timeout=10)
