"""Exercise the visible-worker boundary. --terminal uses a real Mac Terminal with a fixture CLI."""
import json
import os
from pathlib import Path
import pty
import subprocess
import sys
import tempfile
from unittest.mock import patch
import time
import uuid

import visible_session as session
from cmux_sessions import owned_rows

HERE=Path(__file__).resolve().parent
RUNNER=HERE/'run-agent'

def terminal_window_ids():
    query='if application id "com.apple.Terminal" is running then tell application id "com.apple.Terminal" to get id of every window'
    result=subprocess.run(['/usr/bin/osascript','-e',query],check=True,capture_output=True,text=True)
    return {int(i) for i in result.stdout.strip().split(', ') if i}


def until(condition):
    for _ in range(200):
        try:
            if condition():return
        except FileNotFoundError:pass
        time.sleep(.1)
    raise AssertionError('The expected session event did not arrive.')


def verify(base, host):
    root=base/'projects'
    project=root/'Fixture project'
    project.mkdir(parents=True)
    runs=base/'Runs'
    folder=runs/str(uuid.uuid4())
    folder.mkdir(parents=True)
    capture=str(uuid.uuid4())
    job=dict(delivery='interactive',agent='claude',session=folder.name,capture=capture,mode='ask',
             instructions='Fixture instructions',task='Tasktap interactive check',outgoing="Fixture prompt with quotes and $HOME",
             host=host if host!='pty' else 'terminal',folder=str(project))
    path=folder/('1-'+capture+'.job')
    receipt=path.with_suffix('.receipt')
    session.save(path,job)
    fake=base/'claude'
    fake.write_text("""#!/usr/bin/env python3
import json,os,signal,sys,time
from pathlib import Path
assert sys.stdin.isatty() and sys.stdout.isatty()
assert "-p" not in sys.argv
assert sys.argv[-1]=="Fixture prompt with quotes and $HOME"
p=Path.cwd()
if os.environ.get('TERM_PROGRAM')=='Apple_Terminal':
    assert os.get_terminal_size().lines>0 and os.get_terminal_size().columns>0
    assert os.tcgetpgrp(0)==os.getpgrp()
    signal.signal(signal.SIGWINCH,lambda *_:(p/'resized').write_text(str(os.get_terminal_size().columns)))
(p/"started").write_text(os.ttyname(0))
for i in range(350):
    if (p/"finish").exists():break
    time.sleep(.1)
""")
    fake.chmod(0o700)
    env=dict(os.environ,PATH=str(base)+os.pathsep+os.environ['PATH'])
    before=terminal_window_ids() if host=='terminal' else set()
    if host=='pty':
        nogui=subprocess.run([sys.executable,str(RUNNER),'present',str(path),str(fake)],capture_output=True)
        assert nogui.returncode and not (project/'started').exists()
        receipt.unlink()
        master,slave=pty.openpty()
        proc=subprocess.Popen([sys.executable,str(RUNNER),'present',str(path),str(fake)],stdin=slave,stdout=slave,stderr=slave)
    else:
        subprocess.run([sys.executable,str(RUNNER),str(folder)],env=env,check=True)
    try:
        def started():
            if receipt.exists() and session.load(receipt)['state']=='Failed':
                raise AssertionError(session.load(receipt)['message'])
            return (project/'started').exists() and session.load(receipt)['state']=='Opened'
        until(started)
        surface=session.endpoint(folder)
        assert surface['tty']==(project/'started').read_text()
        if host=='terminal':
            window=session.load(folder/'terminal-window.json')
            assert window['tty']==surface['tty'] and window['window'] not in before
            resize="""on run argv
                tell application id "com.apple.Terminal"
                    set w to window id ((item 1 of argv) as integer)
                    set t to tab 1 of w
                    if tty of t is not (item 2 of argv) then error "Fixture identity changed"
                    set number of columns of t to (number of columns of t) + 1
                    return number of columns of t
                end tell
            end run"""
            cols=subprocess.run(['/usr/bin/osascript','-e',resize,str(window['window']),window['tty']],
                                check=True,capture_output=True,text=True).stdout.strip()
            until(lambda:(project/'resized').read_text()==cols)
        rows=list(owned_rows(root,runs,[]))
        assert len(rows)==1 and rows[0]['id']==job['session'] and rows[0]['available']=='yes'
        assert rows[0]['startup']=='pending' and rows[0]['state']=='Awaiting agent'
        config=base/'fixture-claude-config'
        projects=config/'projects'/'fixture'
        projects.mkdir(parents=True)
        transcript=projects/(job['session']+'.jsonl')
        event=dict(type='assistant',sessionId=job['session'],cwd=str(project),message={'model':'fixture'})
        with patch.dict(os.environ,{'CLAUDE_CONFIG_DIR':str(config)}):
            transcript.write_text(json.dumps(dict(event,cwd=str(base)))+'\n')
            assert list(owned_rows(root,runs,[]))[0]['startup']=='pending'
            transcript.write_text(json.dumps(event)+'\n')
            assert list(owned_rows(root,runs,[]))[0]['startup']=='confirmed'
        if host=='pty':
            # Wire a known conversation and prove a nudge can only enqueue in that thread.
            handle=str(uuid.uuid4())
            session.save(folder/'thread.json',{'id':handle})
            with patch.object(subprocess,'run') as send:
                session.nudge(folder,dict(job,agent='codex',mode='nudge',outgoing='Check reflections'))
                assert send.call_args.args[0]==['codex','queue','--thread',handle,'--message','Check reflections']
            (folder/'thread.json').unlink()
        if host!='pty':
            session.focus(folder)
        command=session.cli_command(job,folder,str(fake))
        config=json.loads(command[command.index('--mcp-config')+1])
        bridge=config['mcpServers']['workspace_assistant']
        msg=dict(jsonrpc='2.0',id=1,method='tools/call',params=dict(name='report_result',arguments=dict(capture=capture,summary='Fixture completed.')))
        result=subprocess.run([bridge['command'],*bridge['args']],input=json.dumps(msg)+'\n',capture_output=True,text=True,check=True)
        assert not json.loads(result.stdout)['result'].get('isError') and session.load(receipt)['state']=='Complete'
        subprocess.run([sys.executable,str(RUNNER),str(folder)],env=env,check=True)
    finally:
        (project/'finish').touch()
        if host=='pty':
            proc.wait(timeout=5)
            os.close(master);os.close(slave)
    until(lambda:not session.locked(folder))
    if host=='terminal':
        until(lambda:window['window'] not in terminal_window_ids())
        assert before.issubset(terminal_window_ids()),'Another terminal window disappeared'
    assert list(owned_rows(root,runs,[]))[0]['state']=='Closed' and session.load(receipt)['state']=='Complete'
    try:session.focus(folder)
    except ValueError:pass
    else:raise AssertionError('Focused a closed session')
    # Retrying a legacy job cannot create a background worker.
    legacy=folder/'2-old.job'
    session.save(legacy,dict(job,delivery='legacy'))
    subprocess.run([sys.executable,str(RUNNER),str(folder)],env=env,check=True)
    assert session.load(legacy.with_suffix('.receipt'))['state']=='Failed'
    print('Interactive fixture passed in '+host+' with exact tty, report, closure and no hidden retry.')


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='tasktap-visible-') as temp:
        verify(Path(temp),sys.argv[1].lstrip('-') if len(sys.argv)>1 else 'pty')
