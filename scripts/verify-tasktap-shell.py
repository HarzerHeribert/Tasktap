"""Real shell -> CLI -> native hooks -> PTY metadata, without a model/account."""
import base64
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
import uuid
import tasktap_shell as integration


def until(fn):
    for _ in range(160):
        result=fn()
        if result:return result
        time.sleep(.05)
    raise AssertionError('Timed out waiting for shell integration')


for agent in integration.SUPPORTED:
    assert integration.approval_args(agent,[])
assert not integration.approval_args('codex',['--ask-for-approval=on-request'])
assert not integration.approval_args('codex',['-c','approvals_reviewer="user"'])
assert not integration.approval_args('claude',['--permission-mode','manual'])
assert not integration.approval_args('pi',['--no-approve'])
assert not integration.approval_args('opencode',['--auto=false'])
with patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True):
    for agent in integration.SUPPORTED:
        assert integration.interactive(agent,[])
        assert not integration.interactive(agent,['--help'])
    assert integration.interactive('codex',['-m','model','resume','--last'])
    assert integration.interactive('codex',['-p','profile'])
    assert not integration.interactive('codex',['-c','foo=1','app-server'])
    assert not integration.interactive('claude',['-p','hello'])
    assert not integration.interactive('pi',['--mode=rpc'])
    assert not integration.interactive('opencode',['run','hello'])

with tempfile.TemporaryDirectory(prefix='tasktap-shell-test-') as directory:
    root=Path(directory);project=root/'project';project.mkdir()
    runs=root/'Runs';runs.mkdir();user=root/'user-zdotdir';user.mkdir()
    binaries=root/'actual-bin';binaries.mkdir()
    # User rc still runs, even when it resets PATH. No real rc/config files change.
    (user/'.zshrc').write_text('export TASKTAP_USER_RC_LOADED=yes\nexport PATH='+str(binaries)+':/usr/bin:/bin\n')
    (user/'.zprofile').write_text('export TASKTAP_USER_PROFILE_LOADED=yes\n')
    fake=binaries/'codex'
    fake.write_text('#!'+sys.executable+'\n'+r'''
import json,os,re,shlex,subprocess,sys
from pathlib import Path
args=sys.argv[1:]
commands=[]
for arg in args:
    if arg.startswith('hooks.') and not arg.startswith('hooks.state='):
        commands.append(json.loads(re.search(r'command=("(?:\\.|[^"\\])*")',arg).group(1)))
if 'app-server' in args:
    for line in sys.stdin:
        message=json.loads(line)
        if message.get('method')=='initialize':print(json.dumps(dict(id=1,result={})),flush=True)
        if message.get('method')=='hooks/list':
            hooks=[dict(key='fixture.hooks:'+str(i),currentHash='hash'+str(i),source='sessionFlags',command=cmd) for i,cmd in enumerate(commands)]
            print(json.dumps(dict(id=2,result=dict(data=[dict(hooks=hooks)]))),flush=True)
else:
    Path(os.environ['TASKTAP_TEST_ARGV']).write_text(json.dumps(args))
    assert os.environ['TASKTAP_USER_RC_LOADED']=='yes' and os.environ['TASKTAP_USER_PROFILE_LOADED']=='yes'
    if '--version' in args:print('PASSTHROUGH_VERSION',flush=True);sys.exit(0)
    assert '--approve-for-me' in args and '--no-daemon' in args
    assert len(commands)==8 and any(a.startswith('hooks.state=') for a in args)
    command=shlex.split(commands[0])
    for name,values in [('SessionStart',{}),('UserPromptSubmit',{}),('PermissionRequest',dict(tool_name='Bash'))]:
        subprocess.run(command,input=json.dumps(dict(hook_event_name=name,session_id='provider',**values)),text=True,check=True)
    print('HOOKS_READY_AUTO_REVIEW',flush=True)
    sys.stdin.readline()
    for name,values in [('PostToolUse',dict(tool_name='Bash')),('Stop',dict(last_assistant_message='Copied shell answer.\n'))]:
        subprocess.run(command,input=json.dumps(dict(hook_event_name=name,session_id='provider',**values)),text=True,check=True)
    print('CLI_FINISHED',flush=True)
''')
    fake.chmod(0o700)
    before={p.name:p.read_bytes() for p in user.iterdir()}
    shell=os.environ.get('TASKTAP_TEST_SHELL') or shutil.which('zsh') or shutil.which('bash')
    assert shell,'A supported shell is required for the PTY fixture'
    os.environ.update(TASKTAP_TERMINAL_ROOT=str(root/'Terminals'),ZDOTDIR=str(user),TASKTAP_TEST_ARGV=str(root/'argv.json'),
                      PATH=str(binaries)+os.pathsep+os.environ.get('PATH',os.defpath))
    if Path(shell).name=='bash':
        # CI Linux has Bash; the macOS zsh run verifies actual user startup files.
        os.environ.update(TASKTAP_USER_RC_LOADED='yes',TASKTAP_USER_PROFILE_LOADED='yes')
    import workspace_terminal as terminal
    service=subprocess.Popen([sys.executable,str(Path(terminal.__file__)),'serve'])
    ids=[]
    try:
        until(lambda:(root/'Terminals/session.sock').exists())
        session=str(uuid.uuid4());ids.append(session)
        terminal.request(dict(op='start',id=session,cwd=str(project),kind='shell',title='Terminal',
                              argv=[sys.executable,str(Path(integration.__file__)),'shell',shell,session,str(runs)]))
        def send(text):terminal.request(dict(op='input',id=session,data=base64.b64encode(text.encode()).decode()))
        def replay():return base64.b64decode(terminal.request(dict(op='attach',id=session))['data'])
        send("printf 'READY_%s\\n' SHELL\n")
        until(lambda:b'READY_SHELL\r\n' in replay())
        send('codex --version\n')
        until(lambda:b'PASSTHROUGH_VERSION\r\n' in replay())
        assert not (runs/session/'observer.json').exists()
        assert json.loads((root/'argv.json').read_text())==['--version']
        send('codex\n')
        until(lambda:b'HOOKS_READY_AUTO_REVIEW\r\n' in replay())
        def observation():return next(s for s in terminal.request(dict(op='list'))['sessions'] if s['id']==session).get('observation',{})
        assert observation()['state']=='needsPermission'
        assert observation()['agent']=='codex'
        from cmux_sessions import owned_rows
        fallback=next(owned_rows(root,runs,[],allow_external=False))
        assert json.loads(fallback['observation'])['state']=='needsPermission','the app scan must also recover hooks when an older PTY service is still running'
        send('\n');until(lambda:observation().get('state')=='ended')
        assert (runs/session/'answer-0001.txt').read_text()=='Copied shell answer.\n'
        assert next(s for s in terminal.request(dict(op='list'))['sessions'] if s['id']==session)['running'],'CLI exit must return to the live shell'
        send('codex\n')
        until(lambda:observation().get('state')=='needsPermission' and observation().get('turn')==2)
        send('\n');until(lambda:observation().get('state')=='ended')
        assert len(observation()['answers'])==2 and (runs/session/'answer-0002.txt').exists()
        # A program that pipes input to the CLI must retain native noninteractive behavior.
        send("printf 'hello' | codex --version\n")
        until(lambda:replay().count(b'PASSTHROUGH_VERSION\r\n')==2)
        assert observation()['turn']==2
        assert {p.name:p.read_bytes() for p in user.iterdir()}==before
        print('PASS: real '+Path(shell).name+', private command resolution, bare Codex auto review + eight trusted native hooks, PTY attention events, exact answers, repeated launches, live shell after CLI exit, explicit policy and noninteractive/help passthrough; no global config writes.')
    finally:
        for session in ids:
            try:terminal.request(dict(op='stop',id=session))
            except Exception:pass
        time.sleep(.15);service.terminate();service.wait(timeout=5)
