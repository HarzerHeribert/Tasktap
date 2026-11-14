"""macOS integration check for one terminal adapter. Each session runs a disposable CLI."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time

from terminal_hosts import focus_terminal, open_terminal


def wait_until(check):
    for _ in range(240):
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError('Timed out waiting for the test terminal.')


def attach_process(name):
    # Only the exact random test socket matches. No user session data is retained.
    processes = subprocess.check_output(['/bin/ps','-axo','pid=,command='],text=True)
    for line in processes.splitlines():
        parts=line.strip().split(None,1)
        if len(parts)==2 and parts[1] in ('/usr/bin/screen -x '+name,'screen -x '+name):
            return int(parts[0])


def gui_fixture(host, folder):
    work=folder/"fixture's $ and spaces"
    work.mkdir()
    runner=folder/'fixture.py'
    runner.write_text("""import json,os,sys,time
from pathlib import Path
p=Path(sys.argv[1])
assert sys.stdin.isatty() and sys.stdout.isatty()
with (p/'ready').open('x') as f:
    json.dump(dict(tty=os.ttyname(0),cwd=os.getcwd(),args=sys.argv[2:],socket=os.getenv('STY','')),f)
for i in range(700):
    if (p/'end').exists():break
    time.sleep(.1)
""")
    try:
        open_terminal(host,[sys.executable,str(runner),str(folder),"a ' and $",'-é'],str(work),'Fixture',folder)
        wait_until(lambda: (folder/'ready').is_file())
        data=json.loads((folder/'ready').read_text())
        assert data['args']==["a ' and $",'-é'] and Path(data['cwd']).resolve()==work.resolve()
        focus_terminal(host,data,folder)
        if host=='warp':
            name=(folder/'warp-screen').read_text()
            assert data['socket'].endswith('.'+name)
            wait_until(lambda:attach_process(name))
    finally:
        (folder/'end').touch()
        time.sleep(.4)
    print(host+': verified interactive launch, working folder, literal arguments and original session target.')


def hangup_fixture(folder):
    # Simulate the last Warp tab closing its outer tty while the agent is still waiting.
    started=folder/'screen-child'
    child=folder/'child.py'
    child.write_text('import os,sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(35)\n')
    from unittest.mock import patch
    with patch('terminal_hosts._open_warp'):
        open_terminal('warp',[sys.executable,str(child),str(started)],str(folder),'Hangup',folder)
    pid,master=pty.fork()
    if pid==0:
        os.environ.update(TERM='xterm-256color')
        os.execl(str(folder/'Agent.command'),str(folder/'Agent.command'))
    try:
        # screen waits for a terminal Device Attributes response at startup.
        for _ in range(120):
            if started.exists():break
            if select.select([master],[],[],.1)[0]:
                chunk=os.read(master,4096)
                if not chunk:raise RuntimeError('Screen exited before launching its fixture.')
                if b'\x1b[c' in chunk or b'\x1b[0c' in chunk:os.write(master,b'\x1b[?1;2c')
        if not started.exists():raise RuntimeError('Screen did not attach to the test tty.')
    finally:
        os.close(master)
    agent=int(started.read_text())
    def exited():
        try:os.kill(agent,0)
        except ProcessLookupError:return True
    try:wait_until(exited)
    finally:
        try:os.kill(agent,signal.SIGTERM)
        except ProcessLookupError:pass
        os.waitpid(pid,0)
    print('Closing the final attached screen tty terminates the fixture worker.')


if __name__=='__main__':
    host=sys.argv[1]
    with tempfile.TemporaryDirectory(prefix='tasktap-terminal-') as temp:
        if host=='hangup':hangup_fixture(Path(temp))
        else:gui_fixture(host,Path(temp))
