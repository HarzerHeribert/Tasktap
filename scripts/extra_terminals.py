"""Launch and select Tasktap's own interactive WezTerm and kitty panes on macOS."""
import hashlib
import ctypes
from ctypes.util import find_library
import os
from pathlib import Path
import plistlib
import stat
import subprocess

APPS = {
    'wezterm': ('WezTerm.app', 'com.github.wez.wezterm'),
    'kitty': ('kitty.app', 'net.kovidgoyal.kitty'),
}


def app_bundle(host):
    name, identifier = APPS[host]
    configured = os.environ.get('TASKTAP_TERMINAL_APP')
    candidates = [Path(configured)] if configured else []
    candidates.extend([Path('/Applications') / name, Path.home() / 'Applications' / name])
    for app in candidates:
        try:
            with (app / 'Contents' / 'Info.plist').open('rb') as source:
                if plistlib.load(source).get('CFBundleIdentifier') == identifier:
                    return app
        except (OSError, ValueError, plistlib.InvalidFileException):
            continue
    raise ValueError(f'Install {name[:-4]} or choose another terminal in Session models.')


def kitty_socket(run_dir):
    # Darwin's sockaddr_un path is limited to 103 bytes. Keep the endpoint short
    # even when macOS gives the user's per-app data folder a long path.
    base = Path('/private/tmp') / f'tasktap-kitty-{os.getuid()}'
    try:
        base.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('The private kitty session socket directory is unavailable.')
    key = hashlib.sha256(os.fsencode(Path(run_dir).resolve())).hexdigest()[:32]
    return 'unix:' + str(base / key)


def open_terminal(host, argv, cwd, title, run_dir):
    app = app_bundle(host)
    if host == 'wezterm':
        # A local pane keeps its CLI address even if the user opens other WezTerm domains.
        args = ['start', '--always-new-process', '--no-auto-connect', '--domain', 'local',
                '--cwd', str(cwd), '--', *argv]
    else:
        # Scope remote control to focusing a window in this kitty instance.
        args = ['-o', 'allow_remote_control=password', '-o', 'remote_control_password="" focus-window',
                '--listen-on', kitty_socket(run_dir), '--directory', str(cwd), '--title', title, '--', *argv]
    subprocess.run(['/usr/bin/open', '-n', '-a', str(app), '--args', *args],
                   check=True, capture_output=True, timeout=15)


def _gui_owner(host):
    # Each launch gets a separate local GUI instance. Walk only this terminal's
    # own process ancestry and retain its exact instance for macOS activation.
    executable = 'wezterm-gui' if host == 'wezterm' else 'kitty'
    pid = os.getppid()
    while pid > 1:
        info = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'ppid=', '-o', 'comm='],
                              text=True, capture_output=True, check=True, timeout=3).stdout.strip().split(None, 1)
        if len(info) != 2:
            break
        if Path(info[1]).name == executable:
            return pid
        pid = int(info[0])
    raise ValueError(f'The visible {APPS[host][0][:-4]} process could not be identified.')


def _activate_owner(pid):
    # activate-pane selects the pane inside WezTerm but may leave another Mac
    # application in front. Activate only the GUI instance that owns that pane.
    launch = ctypes.CDLL(find_library('ApplicationServices'))
    serial = (ctypes.c_uint32 * 2)()
    if launch.GetProcessForPID(int(pid), ctypes.byref(serial)) or launch.SetFrontProcessWithOptions(ctypes.byref(serial), 1):
        raise ValueError('The original terminal window could not be brought forward.')


def record_terminal(host, surface):
    if host == 'wezterm':
        socket = os.environ.get('WEZTERM_UNIX_SOCKET', '')
        pane = os.environ.get('WEZTERM_PANE', '')
        if not os.path.isabs(socket):
            raise ValueError('WezTerm did not provide a socket for this interactive pane.')
        surface['weztermSocket'] = socket
    else:
        pane = os.environ.get('KITTY_WINDOW_ID', '')
    if not pane.isascii() or not pane.isdecimal():
        raise ValueError(f'{APPS[host][0][:-4]} did not provide an interactive pane ID.')
    surface['paneID'] = pane
    surface['terminalPID'] = _gui_owner(host)


def focus_terminal(host, surface, run_dir):
    app = app_bundle(host)
    pane = str(surface.get('paneID', ''))
    if not pane.isascii() or not pane.isdecimal():
        raise ValueError('The original terminal pane is unavailable.')
    binary = app / 'Contents' / 'MacOS'
    env = os.environ.copy()
    if host == 'wezterm':
        socket = surface.get('weztermSocket', '')
        if not os.path.isabs(socket):
            raise ValueError('The WezTerm session socket is unavailable.')
        env['WEZTERM_UNIX_SOCKET'] = socket
        cmd = [str(binary / 'wezterm'), 'cli', '--no-auto-start', 'activate-pane', '--pane-id', pane]
    else:
        cmd = [str(binary / 'kitten'), '@', '--to', kitty_socket(run_dir), 'focus-window', '--match', 'id:' + pane]
    subprocess.run(cmd, check=True, capture_output=True, timeout=10, env=env)
    _activate_owner(surface['terminalPID'])
