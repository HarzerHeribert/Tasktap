"""Open and address an interactive agent. Only the foreground 'present' path starts a CLI."""
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

from session_models import model_id

HOST_NAMES={'terminal':'Terminal','cmux':'cmux','ghostty':'Ghostty','warp':'Warp','iterm2':'iTerm2','wezterm':'WezTerm','kitty':'kitty'}


def adapter(host):
    if host in ('ghostty','iterm2','warp'):
        import terminal_hosts
        return terminal_hosts
    if host in ('kitty','wezterm'):
        import extra_terminals
        return extra_terminals
    raise ValueError('Choose an available terminal in Preferences → Session models.')



def save(path, payload):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as out:
        json.dump(payload, out)
        name = out.name
    os.replace(name, path)


def load(path):
    return json.loads(path.read_text())


def locked(folder):
    lock=folder/'surface.lock'
    if not lock.is_file():return False
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def endpoint(folder):
    if not locked(folder):
        raise ValueError('This terminal session has closed. Review its capture in Tasktap.')
    value = load(folder/'surface.json')
    if not value.get('open'):
        raise ValueError('The session is still opening or has closed.')
    return value


def cli_command(job, folder, executable=None):
    agent = job['agent']
    cli = executable or shutil.which(agent)
    if agent not in ('codex','claude','agy') or not cli:
        raise ValueError('Install the selected CLI and sign in before starting a session.')
    model = model_id(job.get('model',''))
    args = ['--model', model] if model else []
    bridge = dict(command=str(Path(__file__).resolve().with_name('agent-tools')),
                  args=['--agent',agent,'--workspace',job['folder'],'--session',job['session'],
                        '--task',job['task'],'--run-dir',str(folder)])
    servers = json.dumps({'mcpServers':{'workspace_assistant':bridge}})
    prompt = job['outgoing']
    if agent == 'claude':
        return [cli, *args, '--session-id', job['session'], '--mcp-config', servers,
                '--append-system-prompt', job['instructions'], '--', prompt]
    if agent == 'codex':
        return [cli, *args, '-c', 'mcp_servers.workspace_assistant.command='+json.dumps(bridge['command']),
                '-c', 'mcp_servers.workspace_assistant.args='+json.dumps(bridge['args']),
                '-c', 'mcp_servers.workspace_assistant.tool_timeout_sec=86400',
                '--', job['instructions']+'\n\n'+prompt]
    return [cli,*args,'--prompt-interactive',prompt]


def open_window(path, job):
    folder = path.parent
    cli = shutil.which(job['agent'])
    if not cli:
        raise ValueError('Install '+job['agent']+' and sign in to its CLI.')
    runner = Path(__file__).resolve().with_name('run-agent')
    # The terminal command contains only quoted local paths. The prompt is read from the private job.
    argv=[sys.executable,str(runner),'present',str(path),cli]
    title='Tasktap · '+''.join(c for c in job['task'][:70] if c.isprintable())
    if job.get('hostApp'):
        os.environ['TASKTAP_TERMINAL_APP']=job['hostApp']
    if job['host']=='cmux':
        import cmux_host
        cmux_host.open_terminal(argv,job['folder'],title,folder)
    elif job['host']=='terminal':
        command='exec '+shlex.join(argv)
        launcher = folder/'Tasktap.command'
        launcher.write_text('#!/bin/sh\n'+command+'\n')
        launcher.chmod(0o700)
        subprocess.run(['/usr/bin/open','-b','com.apple.Terminal',str(launcher)],check=True,
                       capture_output=True,timeout=15)
    else:
        adapter(job['host']).open_terminal(job['host'],argv,job['folder'],title,folder)


def present(path, executable):
    job = load(path)
    folder = path.parent
    if job.get('mode') != 'ask' or not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError('Open the agent in an interactive terminal.')
    with (folder/'surface.lock').open('a') as guard:
        fcntl.flock(guard,fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Double-clicking the launcher or retrying delivery must never rerun the original task.
        if (folder/'surface.json').exists() or (path.with_suffix('.receipt').exists() and load(path.with_suffix('.receipt')).get('state')!='Opening'):
            raise ValueError('This handoff has already opened. Use its session in Tasktap.')
        host = job['host']
        surface = dict(host=host,open=False,tty=os.ttyname(0),pid=os.getpid())
        if job.get('hostApp'):surface['hostApp']=job['hostApp']
        if host in ('kitty','wezterm'):
            adapter(host).record_terminal(host,surface)
        if host == 'cmux':
            for key,env in [('surface','CMUX_SURFACE_ID'),('workspace','CMUX_WORKSPACE_ID')]:
                surface[key] = str(uuid.UUID(os.environ[env]))
        os.environ['PATH'] = os.pathsep.join([str(Path.home()/'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',os.environ.get('PATH',os.defpath)])
        os.environ['WORKSPACE_ASSISTANT_INBOX'] = str(folder.parent.parent/'Agent Inbox')
        if not Path(executable).is_absolute() or not os.access(executable,os.X_OK):
            raise ValueError('The reviewed CLI is unavailable.')
        argv = cli_command(job,folder,executable)
        title='Tasktap · '+''.join(c for c in job['task'][:70] if c.isprintable())
        print('\033]0;'+title+'\007',end='',flush=True)
        # No shell between the reviewed prompt and the agent. The CLI owns the actual terminal.
        proc = subprocess.Popen(argv,cwd=job['folder'])
        surface['open'] = True
        save(folder/'surface.json',surface)
        # A very fast result still belongs to the agent.
        receipt=path.with_suffix('.receipt')
        if not receipt.exists() or load(receipt).get('state')=='Opening':
            save(receipt,dict(state='Opened',message='Interactive session opened in '+HOST_NAMES[host]+'.'))
        try:
            while True:
                try:
                    code = proc.wait()
                    break
                except KeyboardInterrupt:
                    # The foreground CLI receives Ctrl-C too and owns the interrupt decision.
                    continue
        finally:
            surface['open'] = False
            save(folder/'surface.json',surface)
        receipt=path.with_suffix('.receipt')
        if load(receipt).get('state')=='Opened':
            save(receipt,dict(state='Closed' if code==0 else 'Failed',message='The interactive CLI exited with status '+str(code)+'.'))


# Select the exact Terminal tab. Never issue a command in the user's shell.
FOCUS_TAB = """on run argv
    set targetTTY to item 1 of argv
    tell application "Terminal"
        repeat with w in windows
            repeat with t in tabs of w
                if tty of t is targetTTY then
                    set selected tab of w to t
                    set index of w to 1
                    activate
                    return
                end if
            end repeat
        end repeat
    end tell
    error "The original Terminal tab has closed."
end run"""


def focus(folder):
    surface = endpoint(folder)
    if surface.get('hostApp'):os.environ['TASKTAP_TERMINAL_APP']=surface['hostApp']
    if surface['host']=='terminal':
        subprocess.run(['/usr/bin/osascript','-e',FOCUS_TAB,surface['tty']],check=True,capture_output=True,timeout=15)
    elif surface['host']=='cmux':
        focus_cmux(surface)
    else:
        adapter(surface['host']).focus_terminal(surface['host'],surface,folder)


def focus_cmux(surface):
    import cmux_host
    cmux_host.focus_terminal(surface)


def nudge(folder,job):
    surface = endpoint(folder)
    if job['agent']=='codex' and (folder/'thread.json').is_file():
        thread = str(uuid.UUID(load(folder/'thread.json')['id']))
        subprocess.run(['codex','queue','--thread',thread,'--message',job['outgoing']],
                       check=True,cwd=job['folder'],capture_output=True,timeout=15)
        return 'Accepted by the original Codex thread’s queue.'
    if surface['host']=='cmux':
        # The surface must still advertise this exact agent conversation before using its inbox.
        import cmux_sessions as bridge
        conversation = job['session'] if job['agent']=='claude' else None
        if conversation:
            matched = next((r for r in bridge.sessions(Path(job['folder']).parent)
                            if r['surface']==surface['surface'] and r['conversation']==conversation and r['agent']==job['agent']),None)
            if matched:
                return bridge.send_inbox(matched,job['outgoing'])
    raise ValueError('Use Copy nudge & open session to paste the reviewed text in the original terminal.')
