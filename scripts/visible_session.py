"""Open and address an interactive agent in Tasktap's terminal. Only the foreground 'present' path starts a CLI."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from session_models import model_id

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


def cli_command(job, folder, executable=None, resume=None):
    agent = job['agent']
    cli = executable or shutil.which(agent)
    if agent not in ('codex','claude','agy','cursor-agent','pi','opencode') or not cli:
        raise ValueError('Install the selected CLI and sign in before starting a session.')
    model = '' if resume else model_id(job.get('model',''))
    args = ['--model', model] if model else []
    if job.get('observer') is True:
        # The PoC deliberately adds no MCP tools or report instructions to the prompt.
        from session_observer import prepare
        observer_args, _ = prepare(job, folder, resume)
        if agent == 'opencode':
            return [cli, *args, *observer_args, '--auto', '--prompt', job['outgoing']]
        if agent == 'cursor-agent':
            return [cli, *args, *observer_args, '--auto-review', 'agent', '--', job['outgoing']]
        automatic = ['--approve-for-me'] if agent == 'codex' else ['--permission-mode','auto'] if agent == 'claude' else ['--approve'] if agent == 'pi' else []
        if resume:
            return [cli,*args,*observer_args,*automatic,*(['resume',resume] if agent=='codex' else [])]
        return [cli, *args, *observer_args, *automatic, '--', job['outgoing']]
    bridge = dict(command=str(Path(__file__).resolve().with_name('agent-tools')),
                  args=['--agent',agent,'--workspace',job['folder'],'--session',job['session'],
                        '--task',job['task'],'--run-dir',str(folder)])
    servers = json.dumps({'mcpServers':{'workspace_assistant':bridge}})
    prompt = job['outgoing']
    if agent == 'opencode':
        return [cli, *args, '--auto', '--prompt', prompt]
    if agent == 'cursor-agent':
        return [cli, *args, '--auto-review', 'agent', '--', prompt]
    if agent == 'pi':
        return [cli, *args, '--approve', '--session-id', job['session'], '--', prompt]
    if agent == 'claude':
        options = [cli, *args, '--permission-mode', 'auto', '--mcp-config', servers, '--append-system-prompt', job['instructions']]
        return options + (['--resume', resume] if resume else ['--session-id', job['session'], '--', prompt])
    if agent == 'codex':
        reviewed = None if resume else job.get('reviewedFolder')
        if reviewed is not None:
            if job.get('mode') != 'ask' or reviewed != str(Path(job['folder']).resolve(strict=True)):
                raise ValueError('The folder changed. Review its location again before starting Codex.')
            # A TOML inline table treats a folder with dots as one literal key.
            # The override belongs to this CLI process and is never written to its config.
            key = json.dumps(reviewed, ensure_ascii=False).replace(chr(127), '\\u007f')
            args += ['-c', 'projects={'+key+'={trust_level="trusted"}}']
        return [cli, *args, '--approve-for-me', '-c', 'mcp_servers.workspace_assistant.command='+json.dumps(bridge['command']),
                '-c', 'mcp_servers.workspace_assistant.args='+json.dumps(bridge['args']),
                '-c', 'mcp_servers.workspace_assistant.tool_timeout_sec=86400',
                *(('resume', resume) if resume else ('--', codex_prompt(job)))]
    return [cli,*args,'--mode','auto','--prompt-interactive',prompt]


def open_window(path, job, ticket=None):
    cli = shutil.which(job['agent'])
    if not cli:
        raise ValueError('Install '+job['agent']+' and sign in to its CLI.')
    runner = Path(__file__).resolve().with_name('run-agent')
    # The terminal command contains only quoted local paths. The prompt is read from the private job.
    argv=[sys.executable,str(runner),'present',str(path),cli]
    if ticket:
        argv += ['--reopen', ticket]
    import workspace_terminal
    workspace_terminal.request(dict(op='start',id=job['session'],cwd=job['folder'],argv=argv,title=job['task'],kind='agent',restart=bool(ticket)))
    workspace_terminal.request(dict(op='focus',id=job['session']))


def resume_id(folder, job):
    if job.get('shellLaunch'):
        return None # The user resumes this CLI in its existing shell.
    if (job.get('delivery') != 'interactive' or job.get('mode') != 'ask'
            or job.get('session') != folder.name):
        return None
    if job.get('observer') is True and job['agent'] in ('claude','codex'):
        from session_observer import read
        handle = read(folder/'observer.json').get('providerSession')
        if handle:
            return str(uuid.UUID(handle))
    if job['agent']=='codex' and (folder/'thread.json').is_file():
        return str(uuid.UUID(load(folder/'thread.json')['id']))
    if job['agent']=='claude' and ((folder/'claude-turn-started').is_file() or
            any(load(p).get('state')=='Complete' for p in folder.glob('*.receipt'))):
        return str(uuid.UUID(job['session']))
    return None


def reopen(folder):
    with (folder/'.reopen.lock').open('a') as guard:
        fcntl.flock(guard,fcntl.LOCK_EX)
        if locked(folder):
            return focus(folder)
        path = min(folder.glob('*.job'))
        job = load(path)
        if not resume_id(folder, job):
            raise ValueError('This agent has no saved conversation to reopen.')
        request = folder/'reopen.json'
        if request.exists() and time.time()-request.stat().st_mtime < 90:
            raise ValueError('This conversation is already opening.')
        ticket = str(uuid.uuid4())
        save(request, {'ticket':ticket})
        try:
            open_window(path, job, ticket)
        except Exception:
            if request.exists() and load(request).get('ticket')==ticket:
                request.unlink(missing_ok=True)
            raise


def present(path, executable, ticket=None):
    job = load(path)
    folder = path.parent
    if job.get('mode') != 'ask' or not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError('Open the agent in an interactive terminal.')
    with (folder/'surface.lock').open('a') as guard:
        fcntl.flock(guard,fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Double-clicking the launcher or retrying delivery must never rerun the original task.
        handle = None
        if ticket:
            request = folder/'reopen.json'
            if not request.is_file() or load(request).get('ticket') != ticket:
                raise ValueError('This request to reopen the conversation has expired.')
            handle = resume_id(folder, job)
            if not handle:
                raise ValueError('This agent has no saved conversation to reopen.')
            request.unlink()
        elif (folder/'surface.json').exists() or (path.with_suffix('.receipt').exists() and load(path.with_suffix('.receipt')).get('state')!='Opening'):
            raise ValueError('This handoff has already opened. Use its session in Tasktap.')
        surface = dict(open=False,tty=os.ttyname(0),pid=os.getpid())
        os.environ['PATH'] = os.pathsep.join([str(Path.home()/'.local/bin'),str(Path.home()/'.opencode/bin'),'/opt/homebrew/bin','/usr/local/bin',os.environ.get('PATH',os.defpath)])
        os.environ['WORKSPACE_ASSISTANT_INBOX'] = str(folder.parent.parent/'Agent Inbox')
        if not Path(executable).is_absolute() or not os.access(executable,os.X_OK):
            raise ValueError('The reviewed CLI is unavailable.')
        argv = cli_command(job,folder,executable,handle)
        process_env = None
        if job.get('observer') is True:
            # cli_command has already minted this launch's callback configuration.
            process_env = dict(os.environ, TASKTAP_OBSERVER_CONFIG=str(folder/'observer-config.json'),
                               TASKTAP_OBSERVER_PYTHON=sys.executable,
                               TASKTAP_OBSERVER_SCRIPT=str(Path(__file__).resolve().with_name('session_observer.py')))
            if job['agent'] == 'codex':
                from session_observer import codex_trust_overrides
                trust = codex_trust_overrides(executable, folder, job['folder'])
                key = json.dumps(str(Path(job['folder']).resolve()))
                reviewed = None if handle else job.get('reviewedFolder')
                if reviewed is not None and reviewed != str(Path(job['folder']).resolve(strict=True)):
                    raise ValueError('The folder changed. Review its location again before starting Codex.')
                scoped = ['-c','projects={'+key+'={trust_level="trusted"}}'] if reviewed is not None else []
                argv = [argv[0], '--no-daemon', *trust, *scoped, *argv[1:]]
            if job['agent'] == 'opencode':
                extra = json.loads(process_env.get('OPENCODE_CONFIG_CONTENT', '{}'))
                extra['plugin'] = [*extra.get('plugin', []), (Path(__file__).resolve().parent/'observers/opencode').as_uri()]
                process_env['OPENCODE_CONFIG_CONTENT'] = json.dumps(extra)
        title='Tasktap · '+''.join(c for c in job['task'][:70] if c.isprintable())
        print('\033]0;'+title+'\007',end='',flush=True)
        # No shell between the reviewed prompt and the agent. The CLI owns the actual terminal.
        import termios
        from tasktap_shell import restore_terminal
        saved_tty=termios.tcgetattr(sys.stdin.fileno())
        proc = subprocess.Popen(argv,cwd=job['folder'] if handle else job.get('reviewedFolder') or job['folder'],env=process_env)
        surface['open'] = True
        save(folder/'surface.json',surface)
        # A very fast result still belongs to the agent.
        receipt=path.with_suffix('.receipt')
        if not handle and (not receipt.exists() or load(receipt).get('state')=='Opening'):
            save(receipt,dict(state='Opened',message='Interactive session opened in Tasktap.'))
        try:
            while True:
                try:
                    code = proc.wait()
                    break
                except KeyboardInterrupt:
                    # The foreground CLI receives Ctrl-C too and owns the interrupt decision.
                    continue
        finally:
            restore_terminal(saved_tty)
            surface['open'] = False
            save(folder/'surface.json',surface)
            if job.get('observer') is True:
                from session_observer import ingest, read
                token = read(folder/'observer-config.json').get('token', '')
                ingest(folder, token, dict(kind='process_exited', exitCode=proc.poll()))
        receipt=path.with_suffix('.receipt')
        if not handle and load(receipt).get('state')=='Opened':
            message='The terminal session closed.' if code==0 else 'The agent exited before reporting a result. Check the error in Tasktap.'
            save(receipt,dict(state='Closed' if code==0 else 'Failed',message=message))
        return code


def focus(folder):
    endpoint(folder)
    import workspace_terminal
    workspace_terminal.request(dict(op='focus',id=folder.name))


def nudge(folder,job):
    endpoint(folder)
    if job['agent']=='codex' and (folder/'thread.json').is_file():
        thread = str(uuid.UUID(load(folder/'thread.json')['id']))
        subprocess.run(['codex','queue','--thread',thread,'--message',job['outgoing']],
                       check=True,cwd=job['folder'],capture_output=True,timeout=15)
        return 'Accepted by the original Codex thread’s queue.'
    raise ValueError('Use Copy nudge & open session to paste the reviewed text in the original terminal.')
