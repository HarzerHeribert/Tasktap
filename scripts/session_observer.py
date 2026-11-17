"""Launch-scoped observers. No model tools, generated reports, or global installs.

Only native observer=True jobs in Tasktap's own PTY get instrumented. Hooks
write to this run's private journal; successful callbacks deliberately emit nothing.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import selectors
import shlex
import subprocess
import socket
import hashlib
import sys
import tempfile
import time
import uuid

STATES = {
    'launch_started': 'starting', 'cli_started': 'ready',
    'session_started': 'ready', 'turn_started': 'working', 'activity': 'working',
    'continued': 'working', 'permission_requested': 'needsPermission',
    'input_requested': 'needsInput', 'turn_finished': 'ready',
    'turn_failed': 'failed', 'turn_interrupted': 'interrupted', 'process_exited': 'ended',
}
LABELS = {'starting': 'Awaiting agent', 'ready': 'Ready', 'working': 'Running', 'needsPermission': 'Needs input',
          'needsInput': 'Needs input', 'failed': 'Failed', 'interrupted': 'Interrupted', 'ended': 'Closed'}
HERE = Path(__file__).resolve().parent
SUPPORTED = ('claude', 'codex', 'pi', 'opencode')


def public_state(state):
    fields = ('agent','state','isWorking','event','activity','turn','sequence','updatedAt','providerSession',
              'providerTurn','answerFile','error','lastTurnState','exitCode','history','answers','question')
    return {**{k:state[k] for k in fields if k in state},
            'launchId': hashlib.sha256(state.get('launch','').encode()).hexdigest()[:16]}


def publish(folder, token):
    # A callback never starts a terminal service or waits for a UI. Reconnect
    # recovers the latest snapshot from the private run files.
    root = Path(os.environ.get('TASKTAP_TERMINAL_ROOT') or folder.parent.parent/'Terminals')
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(.2)
            client.connect(str(root/'session.sock'))
            client.sendall((json.dumps(dict(op='observe',id=folder.name,runDir=str(folder),token=token))+'\n').encode())
            client.recv(1024)
    except OSError:
        pass


def codex_hook_trust(cli, args, cwd):
    """Trust only our exact callback definitions via invocation overrides, never config writes."""
    process = subprocess.Popen([cli, *args, 'app-server', '--listen', 'stdio://'], cwd=cwd,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        def send(message):
            process.stdin.write((json.dumps(message)+'\n').encode()); process.stdin.flush()
        send(dict(id=1, method='initialize', params=dict(clientInfo=dict(name='tasktap_observer_poc', version='0.1'),
                                                        capabilities=dict(experimentalApi=True))))
        buffer = b''
        deadline = time.monotonic()+12
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline and selector.select(max(0, deadline-time.monotonic())):
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk or len(buffer) > 2*1024*1024: break
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    message = json.loads(line)
                    if message.get('id') == 1:
                        send(dict(method='initialized'))
                        send(dict(id=2, method='hooks/list', params=dict(cwds=[cwd])))
                    if message.get('id') == 2:
                        return message.get('result') or dict(error=message.get('error'))
        return {}
    finally:
        process.terminate()
        try: process.wait(timeout=2)
        except subprocess.TimeoutExpired: process.kill(); process.wait()


def codex_trust_overrides(cli, folder, cwd):
    config = read(Path(folder)/'observer-config.json')
    payload = codex_hook_trust(cli, config['hookArgs'], cwd)
    trusted = {}
    for entry in payload.get('data', []):
        for hook in entry.get('hooks', []):
            # Only Tasktap's exact callbacks from this invocation can be trusted here.
            command = hook.get('command') or hook.get('handler', {}).get('command')
            if hook.get('source') != 'sessionFlags' or command != config['command']:
                continue
            trusted[hook['key']] = hook['currentHash']
    if len(trusted) != 8:
        raise ValueError('Codex did not expose all eight launch-scoped observer hooks; no trust was changed.')
    # Keep paths containing dots/colons as literal TOML keys, just like project trust.
    table = ','.join(json.dumps(key)+'={trusted_hash='+json.dumps(value)+'}' for key,value in trusted.items())
    overrides = ['-c', 'hooks.state={'+table+'}']
    config['trustedArgs'] = overrides
    atomic(Path(folder)/'observer-config.json', config)
    return overrides


def atomic(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as stream:
        os.chmod(stream.name, 0o600)
        json.dump(value, stream, ensure_ascii=False)
    os.replace(stream.name, path)


def read(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {} if default is None else default


def ingest(folder, token, event):
    """Serialize callbacks, fence old launches, and keep outcomes separate from state."""
    folder = Path(folder)
    with (folder/'observer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = read(folder/'observer-config.json')
        if not token or not secrets.compare_digest(token, config.get('token', '')):
            return False
        kind = event.get('kind')
        if kind not in STATES and kind != 'assistant_text':
            return False
        state = read(folder/'observer.json')
        if state.get('launch') != token:
            state = dict(launch=token, session=config['session'], agent=config['agent'],
                         state='starting', turn=config.get('turnBase',0), sequence=0, seen=[],
                         answers=config.get('answers',[]),history=[])
        if state.get('state') == 'ended':
            return False
        if kind=='cli_started' and state.get('state')!='starting':
            return False # A fast native callback already established a later state.
        if state.get('turn',0)>0 and state.get('state') in ('ready','failed','interrupted') and kind in ('activity','continued','assistant_text'):
            return False
        # Subagents must not mark their parent's turn ready.
        if event.get('subagent'):
            return False
        sid = event.get('sessionId')
        if sid and state.get('providerSession') and sid != state['providerSession']:
            return False
        if sid:
            state['providerSession'] = sid
            if config['agent']=='codex':
                try: atomic(folder/'thread.json',dict(id=str(uuid.UUID(sid))))
                except (ValueError,TypeError): pass
        turn = event.get('turnId')
        if turn and state.get('providerTurn') and turn != state['providerTurn'] and kind != 'turn_started':
            return False
        identifier = event.get('id')
        if identifier and identifier in state['seen']:
            return False
        if identifier:
            state['seen'] = (state['seen'] + [identifier])[-128:]
        if kind == 'turn_started':
            state['turn'] += 1
            state['providerTurn'] = turn or ''
            for field in ('finalAnswer', 'answerFile', 'assistantText', 'error', 'activity', 'question'):
                state.pop(field, None)
        if kind == 'turn_finished' and state.get('state') in ('failed', 'interrupted'):
            return False
        state['state'] = STATES.get(kind, state['state'])
        if kind in ('continued','activity'):
            state.pop('question',None)
        state['isWorking'] = state['state'] == 'working'
        state['event'] = kind
        state['updatedAt'] = time.time()
        state['sequence'] += 1
        if isinstance(event.get('activity'), str):
            state['activity'] = event['activity'][:500]
        if isinstance(event.get('question'), str):
            state['question'] = event['question'][:2000]
        text = event.get('text', state.get('assistantText')) if kind == 'turn_finished' else event.get('text')
        if kind in ('assistant_text', 'turn_finished') and isinstance(text, str):
            if kind == 'turn_finished':
                # Preserve the provider's answer verbatim, independently of process exit.
                answer = folder/f"answer-{state['turn']:04d}.txt"
                fd = os.open(answer, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    stream.write(text)
                state.update(finalAnswer=text, answerFile=answer.name)
                state['answers'] = [a for a in state.get('answers',[]) if a['turn'] != state['turn']][-19:]+[
                    dict(turn=state['turn'],file=answer.name,time=state['updatedAt'])]
            else:
                state['assistantText'] = text
                state['activity'] = text[-500:]
        if isinstance(event.get('error'), str):
            state['error'] = event['error'][:500]
        if kind == 'process_exited':
            state['lastTurnState'] = read(folder/'observer.json').get('state', 'starting')
            state['exitCode'] = event.get('exitCode')
        state['history'] = state.get('history', [])[-39:]+[dict(kind=kind,state=state['state'],turn=state['turn'],
            at=state['updatedAt'],activity=state.get('activity',''))]
        atomic(folder/'observer.json', state)
        # Only normalized metadata/public messages are retained, never raw tool output.
        journal = folder/'observer-events.jsonl'
        if journal.exists() and journal.stat().st_size > 2*1024*1024:
            os.replace(journal, folder/'observer-events.previous.jsonl')
        with journal.open('a') as stream:
            os.chmod(journal, 0o600)
            stream.write(json.dumps(dict(sequence=state['sequence'], at=state['updatedAt'],
                                         kind=kind, state=state['state'], turn=state['turn'],
                                         activity=state.get('activity', '')), ensure_ascii=False)+'\n')
    publish(folder, token)
    return True


def native_event(agent, payload):
    name = payload.get('hook_event_name')
    names = {'SessionStart': 'session_started', 'UserPromptSubmit': 'turn_started',
             'PreToolUse': 'activity', 'PostToolUse': 'continued', 'PostToolUseFailure': 'continued',
             'PermissionRequest': 'permission_requested', 'Stop': 'turn_finished',
             'StopFailure': 'turn_failed', 'Interrupt': 'turn_interrupted',
             'SessionEnd': 'process_exited', 'sessionStart': 'session_started',
             'beforeSubmitPrompt': 'turn_started', 'preToolUse': 'activity',
             'postToolUse': 'continued', 'stop': 'turn_finished', 'sessionEnd': 'process_exited',
             'afterAgentResponse': 'assistant_text'}
    event = dict(kind=names.get(name), sessionId=payload.get('session_id') or payload.get('conversation_id'),
                 turnId=payload.get('turn_id') or payload.get('generation_id'), subagent=bool(payload.get('agent_id')))
    if name == 'Notification':
        event['kind'] = {'permission_prompt': 'permission_requested', 'elicitation_dialog': 'input_requested'}.get(payload.get('notification_type'))
    tool = payload.get('tool_name', '')
    if tool:
        event['activity'] = tool
        if name in ('PreToolUse', 'preToolUse') and tool in ('AskUserQuestion', 'request_user_input'):
            event['kind'] = 'input_requested'
            questions=(payload.get('tool_input') or {}).get('questions',[])
            event['question'] = '\n'.join(q.get('question','') for q in questions if isinstance(q,dict))[:2000] or 'The agent has a question. Answer in its terminal.'
    if event.get('kind') == 'permission_requested':
        event['question'] = 'Permission is required in the agent terminal'+(' for '+tool if tool else '')+'.'
    if name in ('Stop', 'stop', 'afterAgentResponse'):
        text = payload.get('last_assistant_message', payload.get('response', payload.get('text')))
        if isinstance(text, str): event['text'] = text
        if payload.get('status') in ('error', 'aborted'):
            event['kind'] = 'turn_failed' if payload['status'] == 'error' else 'turn_interrupted'
    if name == 'StopFailure': event['error'] = str(payload.get('error', 'Provider error'))
    return event


def prepare(job, folder, resume=None):
    """Return process-only arguments/env, leaving all user/project configuration intact."""
    if job.get('observer') is not True:
        raise ValueError('Observers are limited to Tasktap multiplexer launches.')
    folder = Path(folder).resolve()
    agent = job['agent']
    token = secrets.token_hex(16)
    previous = read(folder/'observer.json') if resume or job.get('shellLaunch') else {}
    config = dict(token=token, session=job['session'], agent=agent,
                  turnBase=previous.get('turn',0),answers=previous.get('answers',[]))
    atomic(folder/'observer-config.json', config)
    callback = [sys.executable, str(HERE/'session_observer.py'), 'ingest', str(folder), token, agent]
    command = shlex.join(callback)
    env = dict(os.environ, TASKTAP_OBSERVER_CONFIG=str(folder/'observer-config.json'),
               TASKTAP_OBSERVER_PYTHON=sys.executable, TASKTAP_OBSERVER_SCRIPT=str(HERE/'session_observer.py'))
    events = ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd')
    hooks = {name: [dict(hooks=[dict(type='command', command=command, timeout=3)])] for name in events}
    if agent == 'claude':
        for name in ('Notification', 'StopFailure', 'PostToolUseFailure'):
            hooks[name] = [dict(hooks=[dict(type='command', command=command, timeout=3)])]
        identity = ['--resume',resume] if resume else [] if job.get('shellLaunch') else ['--session-id',job['session']]
        args = ['--settings', json.dumps(dict(hooks=hooks)), *identity]
    elif agent == 'codex':
        hooks['Interrupt'] = [dict(hooks=[dict(type='command', command=command, timeout=3)])]
        args = []
        for name, groups in hooks.items():
            # TOML inline values, not JSON object syntax.
            value = '[{hooks=[{type="command",command='+json.dumps(command)+',timeout=3}]}]'
            args += ['-c', 'hooks.'+name+'='+value]
        # Deliberately retain provider hook trust. Never bypass all existing hooks.
    elif agent == 'cursor-agent':
        plugin = folder/'observer-cursor'
        plugin.mkdir(exist_ok=True, mode=0o700)
        (plugin/'.cursor-plugin').mkdir(exist_ok=True, mode=0o700)
        atomic(plugin/'.cursor-plugin/plugin.json', dict(name='tasktap-observer', version='0.1.0'))
        cursor_hooks = {name: [dict(command=command)] for name in
                        ('sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'afterAgentResponse', 'stop', 'sessionEnd')}
        atomic(plugin/'hooks.json', dict(version=1, hooks=cursor_hooks))
        (plugin/'hooks').mkdir(exist_ok=True)
        atomic(plugin/'hooks/hooks.json', dict(version=1, hooks=cursor_hooks))
        args = ['--plugin-dir', str(plugin)]
    elif agent == 'pi':
        args = ['-e', str(HERE/'observers/pi.mjs')]
    elif agent == 'opencode':
        extra = json.loads(env.get('OPENCODE_CONFIG_CONTENT', '{}'))
        extra['plugin'] = [*extra.get('plugin', []), (HERE/'observers/opencode').as_uri()]
        env['OPENCODE_CONFIG_CONTENT'] = json.dumps(extra)
        args = []
    else:
        raise ValueError('This CLI has no verified launch-only observer adapter yet: '+agent)
    config.update(hookArgs=args, command=command)
    atomic(folder/'observer-config.json', config)
    ingest(folder, token, dict(kind='launch_started'))
    return args, env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['ingest'])
    parser.add_argument('folder', type=Path)
    parser.add_argument('token')
    parser.add_argument('agent')
    parser.add_argument('--normalized', action='store_true')
    args = parser.parse_args()
    # No stdout/stderr feedback to the model. Monitoring failure must not block work.
    try:
        payload = json.loads(sys.stdin.buffer.read(2*1024*1024))
        if not isinstance(payload, dict):
            return
        ingest(args.folder, args.token, payload if args.normalized else native_event(args.agent, payload))
    except (OSError, ValueError, TypeError, KeyError):
        pass


if __name__ == '__main__':
    main()
