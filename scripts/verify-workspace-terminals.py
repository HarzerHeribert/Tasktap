"""Real isolated PTYs: transport, resize, reconnection and lifecycle, no agents/accounts."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def until(fn):
    for _ in range(100):
        value=fn()
        if value:return value
        time.sleep(.05)
    raise AssertionError('Timed out')


with tempfile.TemporaryDirectory(prefix='tasktap-pty-') as directory:
    os.environ['TASKTAP_TERMINAL_ROOT']=directory
    import workspace_terminal as terminal
    daemon=subprocess.Popen([sys.executable,str(Path(terminal.__file__)),'serve'],env=os.environ.copy())
    ids=[]
    try:
        until(lambda:(Path(directory)/'session.sock').exists())
        key=str(uuid.uuid4());ids.append(key)
        cmd=dict(op='start',id=key,cwd=directory,argv=['/bin/sh','-i'],kind='shell',title='Isolated shell',cols=93,rows=31)
        started=terminal.request(cmd)['session'];assert started['running']
        assert terminal.request(cmd)['session']['created']==started['created']
        def input(text):terminal.request(dict(op='input',id=key,data=base64.b64encode(text.encode()).decode()))
        def replay():return base64.b64decode(terminal.request(dict(op='attach',id=key))['data'])
        input("printf '\\033[32mTASKTAP_%s\\033[0m\\n' READY\n")
        until(lambda:b'\x1b[32mTASKTAP_READY\x1b[0m' in replay())
        terminal.request(dict(op='resize',id=key,cols=111,rows=37));input('stty size\n')
        until(lambda:b'37 111' in replay())
        # Closing the bridge disconnects a viewer, not the process.
        bridge=subprocess.Popen([sys.executable,str(Path(terminal.__file__)),'bridge'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        assert json.loads(bridge.stdout.readline())['event']=='sessions'
        bridge.stdin.close();bridge.wait(timeout=5)
        assert next(s for s in terminal.request({'op':'list'})['sessions'] if s['id']==key)['running']
        input("printf 'RECONNECTED\\n'\n");until(lambda:b'RECONNECTED\r\n' in replay())
        # Two terminals must not receive each other's input.
        second=str(uuid.uuid4());ids.append(second)
        terminal.request(dict(cmd,id=second,title='Second shell'))
        assert b'TASKTAP_READY' not in base64.b64decode(terminal.request(dict(op='attach',id=second))['data'])
        # Invalid IDs and input are rejected without taking down the service.
        for bad in [dict(op='input',id='not-a-uuid',data=''),dict(op='input',id=key,data='%%%')]:
            try:terminal.request(bad);raise AssertionError('Invalid request accepted')
            except ValueError:pass
        terminal.request(dict(op='stop',id=key))
        until(lambda:not next(s for s in terminal.request({'op':'list'})['sessions'] if s['id']==key)['running'])
        assert not terminal.request(cmd)['session']['running'],'start must not replay a stopped task'
        assert b'TASKTAP_READY' in replay()
        # Reopening multiple long sessions must not overflow the transport queue.
        large=[]
        for _ in range(2):
            key=str(uuid.uuid4());ids.append(key);large.append(key)
            terminal.request(dict(cmd,id=key,argv=[sys.executable,'-c',"import sys; sys.stdout.write(('history '*15+'\\n')*23000+'END_OF_HISTORY\\n'); sys.stdout.flush() "]))
        until(lambda:all(not row['running'] for row in terminal.request({'op':'list'})['sessions'] if row['id'] in large))
        assert terminal.request(dict(op='attach',id=large[0]))['truncated']
        with terminal.connect() as sock:
            sock.settimeout(10)
            sock.sendall(b''.join(json.dumps(dict(op='attach',id=key)).encode()+b'\n' for key in large))
            with sock.makefile('rb') as stream:
                for key in large:
                    response=json.loads(stream.readline(terminal.LIMIT*2));data=base64.b64decode(response['data'])
                    assert response['id']==key and response['truncated'] and len(data)<=terminal.LIMIT
                    assert b'END_OF_HISTORY' in data
        # An explicit stop can beat a pending launch without leaving an orphan.
        cancelled=str(uuid.uuid4());ids.append(cancelled)
        terminal.request(dict(op='stop',id=cancelled))
        try:terminal.request(dict(cmd,id=cancelled));raise AssertionError('Cancelled launch was started')
        except ValueError:pass
        # Workspace close includes detached terminals and waits for actual exit.
        # A foreground child that ignores TERM is killed even if its parent exits.
        stubborn=str(uuid.uuid4());ids.append(stubborn)
        terminal.request(dict(cmd,id=stubborn,argv=[sys.executable,'-c',"import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('STUBBORN_READY',flush=True); time.sleep(30)"]))
        until(lambda:b'STUBBORN_READY' in base64.b64decode(terminal.request(dict(op='attach',id=stubborn))['data']))
        with terminal.connect() as watcher:
            watcher.settimeout(6);stream=watcher.makefile('rb')
            watcher.sendall(b'{"op":"watch"}\n');stream.readline()
            queued=str(uuid.uuid4());ids.append(queued)
            response=terminal.request(dict(op='stop-workspace',cwd=directory,ids=[queued]));assert response['event']=='workspace-stopping'
            while True:
                event=json.loads(stream.readline(terminal.LIMIT*2))
                if event.get('event')=='workspace-closed':break
            assert event['cwd']==directory
        assert not any(row['running'] for row in terminal.request({'op':'list'})['sessions'])
        late=str(uuid.uuid4());ids.append(late)
        try:terminal.request(dict(cmd,id=late));raise AssertionError('Late launch escaped workspace close')
        except ValueError:pass
        # Fences and cancelled launches survive service restart; opening a
        # workspace permits new work but never restarts its old sessions.
        daemon.terminate();daemon.wait(timeout=5)
        daemon=subprocess.Popen([sys.executable,str(Path(terminal.__file__)),'serve'],env=os.environ.copy())
        until(lambda:terminal.request({'op':'list'}))
        try:terminal.request(dict(cmd,id=late));raise AssertionError('Restart lost workspace close')
        except ValueError:pass
        terminal.request(dict(op='open-workspace',cwd=directory))
        try:terminal.request(dict(cmd,id=queued));raise AssertionError('An old queued launch escaped after reopening')
        except ValueError:pass
        assert terminal.request(dict(cmd,id=late))['session']['running']
        assert not terminal.request(dict(cmd,id=second))['session']['running'],'reopen must not rerun old sessions'
        print('PASS: real PTYs, replay, explicit stop, bounded history, pending-launch cancellation, workspace stop including detached/stubborn processes, late-launch fences, persisted closure, and explicit reopen without rerunning old sessions.')
    finally:
        for key in ids:
            try:terminal.request(dict(op='stop',id=key))
            except Exception:pass
        time.sleep(.2);daemon.terminate();daemon.wait(timeout=5)
