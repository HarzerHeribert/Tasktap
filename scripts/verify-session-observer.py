"""Observer lifecycle/isolation tests, including real subprocess hooks and a real Tasktap PTY."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch
import tomllib

import session_observer as observer
import visible_session

HERE = Path(__file__).resolve().parent


def until(fn):
    for _ in range(160):
        if result := fn(): return result
        time.sleep(.05)
    raise AssertionError('Timed out waiting for fixture')


# Short Unix-domain socket paths work on both macOS and the Linux CI runner.
with tempfile.TemporaryDirectory(prefix='tasktap-observer-test-', dir='/tmp') as temp:
    base = Path(temp)
    project = base/'project'; project.mkdir()
    run = base/'Runs'/str(uuid.uuid4()); run.mkdir(parents=True)
    job = dict(agent='claude', host='tasktap', observer=True, session=run.name, folder=str(project),
               outgoing='Original prompt', instructions='DO NOT INJECT THIS', model='')
    args, env = observer.prepare(job, run)
    token = observer.read(run/'observer-config.json')['token']
    send = lambda **event: observer.ingest(run, token, event)
    snapshot = lambda: observer.read(run/'observer.json')
    send(kind='turn_started', sessionId='provider', turnId='turn1', id='start1')
    assert snapshot()['isWorking'] and snapshot()['turn'] == 1
    assert not send(kind='turn_started', sessionId='provider', turnId='turn1', id='start1')
    assert not send(kind='turn_finished', sessionId='child', subagent=True, text='wrong')
    assert not send(kind='turn_finished', sessionId='provider', turnId='stale', text='wrong')
    send(kind='permission_requested', sessionId='provider', turnId='turn1')
    assert snapshot()['state'] == 'needsPermission' and not snapshot()['isWorking']
    send(kind='continued', sessionId='provider', turnId='turn1')
    send(kind='input_requested', sessionId='provider', turnId='turn1')
    assert snapshot()['state'] == 'needsInput'
    send(kind='activity', sessionId='provider', turnId='turn1', activity='Read')
    answer = 'The existing answer.\n\n✓ Markdown **stays unchanged**.\n'
    send(kind='turn_finished', sessionId='provider', turnId='turn1', text=answer)
    assert snapshot()['state'] == 'ready' and snapshot()['finalAnswer'] == answer
    assert (run/snapshot()['answerFile']).read_text() == answer
    send(kind='turn_started', sessionId='provider', turnId='turn2')
    assert 'finalAnswer' not in snapshot() and (run/'answer-0001.txt').read_text() == answer
    send(kind='turn_failed', sessionId='provider', turnId='turn2', error='Provider failed')
    assert not send(kind='turn_finished', sessionId='provider', turnId='turn2', text='not success')
    send(kind='process_exited', exitCode=1)
    assert snapshot()['lastTurnState'] == 'failed' and snapshot()['exitCode'] == 1
    assert not send(kind='continued')
    # A callback from a retired launch cannot overwrite the new launch.
    observer.prepare(job, run)
    assert not observer.ingest(run, token, dict(kind='turn_finished', text='late'))
    token = observer.read(run/'observer-config.json')['token']
    send(kind='turn_started', sessionId='provider')
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda n: send(kind='activity', sessionId='provider', activity=f'tool-{n}'), range(30)))
    assert snapshot()['sequence'] == 32
    # Run an actual configured native hook and prove no feedback enters model context.
    args, _ = observer.prepare(job, run)
    settings = json.loads(args[1])
    command = shlex.split(settings['hooks']['Stop'][0]['hooks'][0]['command'])
    result = subprocess.run(command, input=json.dumps(dict(hook_event_name='Stop', session_id='claude-id',
                            last_assistant_message=answer)), text=True, capture_output=True, check=True)
    assert result.stdout == result.stderr == '' and snapshot()['finalAnswer'] == answer
    assert not (project/'.claude').exists()
    for agent in ('codex','claude','cursor-agent','pi','opencode'):
        candidate = dict(job, agent=agent)
        argv = visible_session.cli_command(candidate, run, '/bin/fixture')
        assert candidate['outgoing'] in argv and not any('DO NOT INJECT THIS' in a or 'mcp_servers' in a for a in argv)
        assert '--dangerously-bypass-hook-trust' not in argv
    # Trust only this launch's exact callbacks, with literal keys containing dots.
    observer.prepare(dict(job, agent='codex'), run)
    config = observer.read(run/'observer-config.json')
    metadata = [dict(key=f'/path.with.dots/config.toml:event:{n}', currentHash=f'sha256:{n}',
                     source='sessionFlags', command=config['command']) for n in range(8)]
    unrelated = dict(key='other-hook', currentHash='sha256:other', source='user', command='unrelated command')
    with patch.object(observer, 'codex_hook_trust', return_value=dict(data=[dict(hooks=metadata+[unrelated])])):
        overrides = observer.codex_trust_overrides('/fixture',run,str(project))
        trust = tomllib.loads(overrides[1])['hooks']['state']
        assert len(trust) == 8 and 'other-hook' not in trust and metadata[0]['key'] in trust
    # Cursor delivers answer text in afterAgentResponse, separately from stop.
    observer.prepare(dict(job, agent='cursor-agent'), run)
    token = observer.read(run/'observer-config.json')['token']
    cursor = lambda name, **values: observer.ingest(run, token, observer.native_event('cursor-agent',
                         dict(hook_event_name=name, conversation_id='cursor', generation_id='generation', **values)))
    cursor('beforeSubmitPrompt')
    cursor('afterAgentResponse', text=answer)
    cursor('stop', status='completed')
    assert snapshot()['finalAnswer'] == answer and snapshot()['state'] == 'ready'
    assert observer.native_event('claude', dict(hook_event_name='Notification', notification_type='idle_prompt'))['kind'] is None
    # An interrupted turn cannot be promoted to ready by a delayed stop event.
    observer.prepare(job, run)
    token = observer.read(run/'observer-config.json')['token']
    send(kind='turn_started', sessionId='interrupted-session', turnId='interrupted-turn')
    send(kind='turn_interrupted', sessionId='interrupted-session', turnId='interrupted-turn')
    assert snapshot()['state'] == 'interrupted' and not snapshot()['isWorking']
    assert not send(kind='turn_finished', sessionId='interrupted-session', turnId='interrupted-turn', text='late')
    assert not send(kind='continued',sessionId='interrupted-session',turnId='interrupted-turn')
    assert 'finalAnswer' not in snapshot()
    # Resuming keeps previous answers and does not reissue the original prompt.
    observer.prepare(job,run)
    token=observer.read(run/'observer-config.json')['token']
    send(kind='turn_started',sessionId=job['session'])
    send(kind='turn_finished',sessionId=job['session'],text=answer)
    send(kind='process_exited',exitCode=0)
    command=visible_session.cli_command(job,run,'/bin/fixture',resume=job['session'])
    assert '--resume' in command and job['outgoing'] not in command
    token=observer.read(run/'observer-config.json')['token']
    send(kind='turn_started',sessionId=job['session'])
    assert snapshot()['turn']==2 and snapshot()['answers'][0]['turn']==1
    for host in ('terminal','cmux','ghostty'):
        try:
            observer.prepare(dict(job, host=host), run)
            raise AssertionError('External host was instrumented')
        except ValueError: pass
    try:
        observer.prepare(dict(job, agent='agy'), run)
        raise AssertionError('Unverified injection should not be claimed')
    except ValueError: pass

    # The fixture owns a real Tasktap PTY and emits provider-shaped hooks.
    cli = base/'fixture-claude'
    cli.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys,time
from pathlib import Path
assert sys.stdin.isatty() and sys.stdout.isatty()
assert "--mcp-config" not in sys.argv and "--append-system-prompt" not in sys.argv
settings=json.loads(sys.argv[sys.argv.index('--settings')+1])
def event(name, **payload):
    import shlex
    cmd=shlex.split(settings['hooks'][name][0]['hooks'][0]['command'])
    r=subprocess.run(cmd,input=json.dumps(dict(hook_event_name=name,session_id='fixture-session',**payload)),text=True,capture_output=True)
    assert not r.stdout and not r.stderr and r.returncode==0
event('SessionStart')
event('UserPromptSubmit')
event('PreToolUse',tool_name='Read',tool_input={'secret':'MUST_NOT_BE_RETAINED'})
event('PostToolUse',tool_name='Read')
event('PermissionRequest',tool_name='Bash')
event('PostToolUse',tool_name='Bash')
event('Stop',last_assistant_message='EXACT_PTY_ANSWER\\n')
print('FIXTURE_READY',flush=True)
while not (Path.cwd()/'finish').exists(): time.sleep(.05)
''')
    cli.chmod(0o700)
    os.environ['TASKTAP_TERMINAL_ROOT'] = str(base/'PTY')
    import workspace_terminal as terminal
    daemon = subprocess.Popen([sys.executable, str(HERE/'workspace_terminal.py'), 'serve'])
    try:
        until(lambda:(base/'PTY/session.sock').exists())
        capture = str(uuid.uuid4())
        job.update(mode='ask', delivery='interactive', capture=capture, task='Fixture')
        path = run/('1-'+capture+'.job')
        visible_session.save(path, job)
        visible_session.save(path.with_suffix('.receipt'), dict(state='Opening'))
        terminal.request(dict(op='start', id=run.name, cwd=str(project), kind='agent', title='Fixture',
                              argv=[sys.executable,str(HERE/'run-agent'),'present',str(path),str(cli)]))
        until(lambda:snapshot().get('finalAnswer') == 'EXACT_PTY_ANSWER\n')
        assert terminal.request(dict(op='list'))['sessions'][0]['running'], 'turn end must not end the CLI'
        published=terminal.request(dict(op='list'))['sessions'][0]['observation']
        assert published['state']=='ready' and published['answers'][-1]['turn']==1
        assert 'finalAnswer' not in published, 'PTY metadata keeps large answer bodies on disk'
        replay = base64.b64decode(terminal.request(dict(op='attach',id=run.name))['data'])
        until(lambda:b'FIXTURE_READY' in base64.b64decode(terminal.request(dict(op='attach',id=run.name))['data']))
        journal = (run/'observer-events.jsonl').read_text()
        assert 'MUST_NOT_BE_RETAINED' not in journal
        assert 'needsPermission' in journal and 'working' in journal
        from cmux_sessions import owned_rows
        row = next(owned_rows(base, run.parent, []))
        assert row['state'] == 'Ready' and json.loads(row['observation'])['answerFile'] == 'answer-0001.txt'
        assert 'finalAnswer' not in json.loads(row['observation']), 'large answers are fetched on demand'
        (project/'finish').touch()
        until(lambda:snapshot()['state'] == 'ended')
        assert snapshot()['lastTurnState'] == 'ready' and snapshot()['finalAnswer'] == 'EXACT_PTY_ANSWER\n'
        assert observer.read(path.with_suffix('.receipt'))['state'] != 'Complete', 'observation does not claim task success'
    finally:
        try: terminal.request(dict(op='stop',id=run.name))
        except (OSError, ValueError): pass
        daemon.terminate(); daemon.wait(timeout=5)

print('PASS: state transitions, exact answer copying, no hook feedback, concurrency, stale/subagent isolation, launch-only config, real Tasktap PTY, live turn vs process exit, and discovery.')
