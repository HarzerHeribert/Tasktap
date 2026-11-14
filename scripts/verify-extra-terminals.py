"""Test WezTerm and kitty pane addressing. --gui HOST opens two temporary fixture sessions."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import extra_terminals as hosts

HERE = Path(__file__).resolve()


def test_arguments():
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        for name, (bundle, identifier) in hosts.APPS.items():
            app = base / bundle
            app.joinpath('Contents').mkdir(parents=True)
            app.joinpath('Contents', 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': identifier}))
            with patch.dict(os.environ, {'TASKTAP_TERMINAL_APP': str(app)}), patch.object(hosts, '_gui_owner', return_value=123), patch.object(hosts, '_activate_owner') as activate, patch.object(subprocess, 'run') as run:
                hosts.open_terminal(name, ['/fixture', 'a;touch "no"'], base, 'Task title', base)
                args = run.call_args.args[0]
                assert args[-2:] == ['/fixture', 'a;touch "no"']
                assert str(app) in args
                with patch.dict(os.environ, {'WEZTERM_PANE':'12', 'WEZTERM_UNIX_SOCKET':'/tmp/example', 'KITTY_WINDOW_ID':'14'}):
                    surface = {}
                    hosts.record_terminal(name, surface)
                    hosts.focus_terminal(name, surface, base)
                assert activate.call_args.args == (123,)
                cmd = run.call_args.args[0]
                if name == 'wezterm':
                    assert cmd[-2:] == ['--pane-id', '12']
                    assert '--no-auto-start' in cmd
                    assert run.call_args.kwargs['env']['WEZTERM_UNIX_SOCKET'] == '/tmp/example'
                else:
                    assert cmd[-3:] == ['focus-window','--match','id:14']
                    assert hosts.kitty_socket(base) != hosts.kitty_socket(base/'another-session')
                try:
                    hosts.focus_terminal(name, {'paneID':'-active'}, base)
                except ValueError:
                    pass
                else:
                    raise AssertionError('invalid pane ID accepted')
    print('Verified separate argv, bundle selection and exact pane focus for both hosts.')


def gui(host):
    with tempfile.TemporaryDirectory(prefix='tasktap-terminal-') as temp:
        base = Path(temp)
        fixture = base / 'a folder with spaces'
        fixture.mkdir()
        surfaces=[]
        try:
            for n in (1, 2):
                run_dir = base / str(n)
                run_dir.mkdir()
                argv=[sys.executable,str(HERE),'--inside',host,str(run_dir),'quotes "$HOME" ;']
                hosts.open_terminal(host,argv,fixture,'Tasktap host verification '+str(n),run_dir)
                for _ in range(100):
                    if (run_dir/'started').exists():
                        surfaces.append(json.loads((run_dir/'started').read_text()))
                        break
                    time.sleep(.1)
                else:
                    raise RuntimeError(f'{host}: no fixture TTY in the new window')
            assert surfaces[0]['tty'] != surfaces[1]['tty']
            for n in (1,2,1):
                run_dir=base/str(n)
                hosts.focus_terminal(host,surfaces[n-1],run_dir)
                time.sleep(.45)
                front = subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,check=True,text=True).stdout.strip()
                pid = subprocess.run(['/usr/bin/lsappinfo','info','-only','pid',front],capture_output=True,check=True,text=True).stdout
                import re
                fg = int(re.search(r'=\s*(\d+)',pid).group(1))
                # Foreground should be the process owning *this* fixture, even
                # though the two GUI instances have the same bundle identifier.
                if fg not in surfaces[n-1]['parents'] or fg in surfaces[2-n]['parents']:
                    raise AssertionError(f'{host}: frontmost PID {fg}, expected owner PID {surfaces[n-1].get("terminalPID")}, other owner {surfaces[2-n].get("terminalPID")}')
            print(f'{host} opened two real interactive windows and returned focus to each exact owner.')
        finally:
            # Only the test-created processes in our private directory see this signal.
            (base/'done').touch()
            time.sleep(.65)


def inside(host,run_dir,marker):
    assert marker=='quotes "$HOME" ;' and Path.cwd().name=='a folder with spaces'
    assert sys.stdin.isatty() and sys.stdout.isatty()
    surface={'tty':os.ttyname(0),'parents':[]}
    hosts.record_terminal(host,surface)
    pid=os.getppid()
    while pid>1:
        surface['parents'].append(pid)
        pid=int(subprocess.run(['/bin/ps','-o','ppid=','-p',str(pid)],capture_output=True,check=True,text=True).stdout)
    run_dir=Path(run_dir)
    (run_dir/'tmp').write_text(json.dumps(surface))
    (run_dir/'tmp').replace(run_dir/'started')
    for _ in range(450):
        if (run_dir.parent/'done').exists():break
        time.sleep(.1)


if __name__=='__main__':
    if sys.argv[1:2]==['--inside']:inside(*sys.argv[2:])
    elif sys.argv[1:2]==['--gui']:gui(sys.argv[2])
    else:test_arguments()
