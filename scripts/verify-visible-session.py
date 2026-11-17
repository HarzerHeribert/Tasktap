"""Exercise the interactive-worker boundary with a fixture CLI on a real pty or Tasktap's terminal service."""
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
from session_rows import rows as session_rows

HERE=Path(__file__).resolve().parent
RUNNER=HERE/'run-agent'

def until(condition):
    for _ in range(200):
        try:
            if condition():return
        except FileNotFoundError:pass
        time.sleep(.1)
    raise AssertionError('The expected session event did not arrive.')


def verify(base, host):
    if host=='tasktap':os.environ['TASKTAP_TERMINAL_ROOT']=str(base/'Terminals')
    root=base/'projects'
    project=root/'Fixture project'
    project.mkdir(parents=True)
    runs=base/'Runs'
    folder=runs/str(uuid.uuid4())
    folder.mkdir(parents=True)
    capture=str(uuid.uuid4())
    job=dict(delivery='interactive',agent='claude',session=folder.name,capture=capture,mode='ask',
             instructions='Fixture instructions',task='Tasktap interactive check',outgoing="Fixture prompt with quotes and $HOME",
             folder=str(project))
    path=folder/('1-'+capture+'.job')
    receipt=path.with_suffix('.receipt')
    session.save(path,job)
    fake=base/'claude'
    fake.write_text("""#!/usr/bin/env python3
import os,sys,time
from pathlib import Path
assert sys.stdin.isatty() and sys.stdout.isatty()
assert "-p" not in sys.argv
if "--resume" in sys.argv:
    assert "Fixture prompt with quotes and $HOME" not in sys.argv
    (Path.cwd()/"resumed").write_text(sys.argv[sys.argv.index("--resume")+1])
else:
    assert sys.argv[-1]=="Fixture prompt with quotes and $HOME"
p=Path.cwd()
(p/"started").write_text(os.ttyname(0))
for i in range(350):
    if (p/"finish").exists():break
    time.sleep(.1)
""")
    fake.chmod(0o700)
    env=dict(os.environ,PATH=str(base)+os.pathsep+os.environ['PATH'])
    env['CLAUDE_CONFIG_DIR']=str(base/'fixture-claude-config')
    if host=='pty':
        nogui=subprocess.run([sys.executable,str(RUNNER),'present',str(path),str(fake)],capture_output=True)
        assert nogui.returncode and not (project/'started').exists()
        receipt.unlink()
        master,slave=pty.openpty()
        proc=subprocess.Popen([sys.executable,str(RUNNER),'present',str(path),str(fake)],stdin=slave,stdout=slave,stderr=slave,env=env)
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
        rows=session_rows(runs)
        assert len(rows)==1 and rows[0]['id']==job['session'] and rows[0]['available']=='yes'
        assert rows[0]['startup']=='pending' and rows[0]['state']=='Connected'
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
        if host=='tasktap':
            time.sleep(9)
            assert session.locked(folder),'Embedded workers must stay available after reporting a result'
        if host=='pty':
            (project/'finish').touch()
            assert proc.wait(timeout=15)==0
            (project/'finish').unlink()
            with patch.object(session,'open_window') as launch:
                session.reopen(folder)
                ticket=launch.call_args.args[2]
                try:session.reopen(folder)
                except ValueError:pass
                else:raise AssertionError('Duplicate resume opened')
            proc=subprocess.Popen([sys.executable,str(RUNNER),'present',str(path),str(fake),'--reopen',ticket],
                                  stdin=slave,stdout=slave,stderr=slave,env=env)
            until(lambda:(project/'resumed').read_text()==job['session'])
            assert session.endpoint(folder)['open'] and session.load(receipt)['state']=='Complete'
    finally:
        (project/'finish').touch()
        if host=='pty':
            proc.wait(timeout=5)
            os.close(master);os.close(slave)
    until(lambda:not session.locked(folder))
    history=session_rows(runs)[0]
    assert history['state']=='Complete' and history['resumable']=='yes' and session.load(receipt)['state']=='Complete'
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
