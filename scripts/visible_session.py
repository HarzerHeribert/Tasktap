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

# Without an "in" argument Terminal allocates a new window. The command replaces its
# login shell, so an agent exit cannot drop the user into another shell in that tab.
OPEN_TERMINAL = """on run argv
    tell application id "com.apple.Terminal"
        set agentTab to do script (item 1 of argv)
        set targetTTY to tty of agentTab
        repeat with w in windows
            if tty of selected tab of w is targetTTY then
                set windowID to id of w
                activate
                return (windowID as text) & linefeed & targetTTY
            end if
        end repeat
    end tell
    error "Could not identify the new Tasktap terminal."
end run"""

# Terminal may have already closed the window according to its profile. An empty
# process list (after our exec'd presenter has exited) protects a repurposed tab.
# If the user grouped another tab with ours, leave the entire window alone.
CLOSE_FINISHED_TERMINAL = """on run argv
    set windowID to (item 1 of argv) as integer
    set targetTTY to item 2 of argv
    repeat 40 times
        if application id "com.apple.Terminal" is not running then return
        tell application id "com.apple.Terminal"
            if not (exists window id windowID) then return
            set w to window id windowID
            if (count of tabs of w) is not 1 then return
            set t to tab 1 of w
            if tty of t is not targetTTY then return
            if not busy of t and (count of processes of t) is 0 then
                close w
                return
            end if
        end tell
        delay 0.15
    end repeat
end run"""


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
    with lock.open('rb') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
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


def codex_prompt(job):
    # Codex uses the start of the first message as the conversation's default title.
    return job['outgoing']+'\n\n'+job['instructions']


def cli_command(job, folder, executable=None):
    agent = job['agent']
    cli = executable or shutil.which(agent)
    if agent not in ('codex','claude','agy','cursor-agent','pi') or not cli:
        raise ValueError('Install the selected CLI and sign in before starting a session.')
    model = model_id(job.get('model',''))
    args = ['--model', model] if model else []
    bridge = dict(command=str(Path(__file__).resolve().with_name('agent-tools')),
                  args=['--agent',agent,'--workspace',job['folder'],'--session',job['session'],
                        '--task',job['task'],'--run-dir',str(folder)])
    servers = json.dumps({'mcpServers':{'workspace_assistant':bridge}})
    prompt = job['outgoing']
    if job.get('mode')=='ask' and job.get('autoReviewActions') is True:
        if agent=='codex':
            args.append('--approve-for-me')
        elif agent=='claude':
            args += ['--permission-mode','auto']
    if agent == 'cursor-agent':
        return [cli, *args, 'agent', '--', prompt]
    if agent == 'pi':
        return [cli, *args, '--session-id', job['session'], '--', prompt]
    if agent == 'claude':
        return [cli, *args, '--session-id', job['session'], '--mcp-config', servers,
                '--append-system-prompt', job['instructions'], '--', prompt]
    if agent == 'codex':
        reviewed = job.get('reviewedFolder')
        if reviewed is not None:
            if job.get('mode') != 'ask' or reviewed != str(Path(job['folder']).resolve(strict=True)):
                raise ValueError('The folder changed. Review its location again before starting Codex.')
            # A TOML inline table treats a folder with dots as one literal key.
            # The override belongs to this CLI process and is never written to its config.
            key = json.dumps(reviewed, ensure_ascii=False).replace(chr(127), '\\u007f')
            args += ['-c', 'projects={'+key+'={trust_level="trusted"}}']
        return [cli, *args, '-c', 'mcp_servers.workspace_assistant.command='+json.dumps(bridge['command']),
                '-c', 'mcp_servers.workspace_assistant.args='+json.dumps(bridge['args']),
                '-c', 'mcp_servers.workspace_assistant.tool_timeout_sec=86400',
                '--', codex_prompt(job)]
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
        result=subprocess.run(['/usr/bin/osascript','-e',OPEN_TERMINAL,'exec '+shlex.join([*argv,'--dedicated-window'])],
                              check=True,capture_output=True,text=True,timeout=45)
        ident,tty=result.stdout.strip().splitlines()
        save(folder/'terminal-window.json',{'window':int(ident),'tty':tty})
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
        # Erase the shell launch banner from this fresh Terminal window before the
        # TUI draws. Input, colors, resize events and interrupts stay on its real tty.
        clear='\033[2J\033[H' if host=='terminal' else ''
        print(clear+'\033]0;'+title+'\007',end='',flush=True)
        # No shell between the reviewed prompt and the agent. The CLI owns the actual terminal.
        proc = subprocess.Popen(argv,cwd=job.get('reviewedFolder') or job['folder'])
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
            message='The terminal session closed.' if code==0 else 'The agent exited before reporting a result. Check the error in '+HOST_NAMES[host]+'.'
            save(receipt,dict(state='Closed' if code==0 else 'Failed',message=message))
        return code


def close_finished_terminal(folder, tty):
    # The runner can finish before the launching Apple event has returned its window ID.
    import time
    for _ in range(40):
        try:
            record=load(folder/'terminal-window.json')
            break
        except FileNotFoundError:
            time.sleep(.1)
    else:
        return
    if record['tty']!=tty:
        return
    subprocess.run(['/usr/bin/osascript','-e',CLOSE_FINISHED_TERMINAL,str(record['window']),tty],
                   stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=12)


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
