"""Read plan limits through installed CLI control protocols. Never opens a model turn."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
import os
import selectors
import shutil
import subprocess
import tempfile
import time


def windows(agent, payload, now):
    if agent == 'codex':
        bucket = (payload.get('rateLimitsByLimitId') or {}).get('codex') or payload.get('rateLimits') or {}
        if bucket.get('limitId') not in (None, 'codex'):
            return []
        items = [(row.get('windowDurationMins'), row.get('usedPercent'), row.get('resetsAt'))
                 for row in [bucket.get('primary'), bucket.get('secondary')] if isinstance(row, dict)]
    else:
        rates = payload.get('rate_limits') or {}
        items = [(mins, row.get('utilization'), row.get('resets_at'))
                 for name, mins in [('five_hour', 300), ('seven_day', 10080)]
                 if isinstance(row := rates.get(name), dict)]
    result = []
    for mins, used, reset in items:
        if isinstance(reset, str):
            try:
                reset = datetime.fromisoformat(reset.replace('Z', '+00:00')).timestamp()
            except (ValueError, OverflowError):
                continue
        if type(used) not in (int, float) or not 0 <= used <= 100 or type(reset) not in (int, float) or not math.isfinite(reset) or reset <= now:
            continue
        result.append(dict(remaining=math.floor(100-used), resetsAt=int(reset), minutes=mins if type(mins) is int else 0))
    return result


def control_result(agent, identity=False):
    cli = shutil.which(agent)
    if not cli:
        return {}
    argv = [cli, 'app-server', '--listen', 'stdio://'] if agent == 'codex' else [
        cli, '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', '',
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    try:
        with tempfile.TemporaryDirectory() as cwd, subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                                     stderr=subprocess.DEVNULL) as process:
            def send(message):
                process.stdin.write((json.dumps(message)+'\n').encode())
                process.stdin.flush()
            try:
                if agent == 'codex':
                    send(dict(method='initialize', id=1, params=dict(clientInfo=dict(name='tasktap', version='1'))))
                else:
                    send(dict(type='control_request', request_id='limits', request=dict(subtype='get_usage', skip_behaviors=True)))
                deadline = time.monotonic()+10
                buffer = b''
                with selectors.DefaultSelector() as events:
                    events.register(process.stdout, selectors.EVENT_READ)
                    while time.monotonic() < deadline and events.select(max(0, deadline-time.monotonic())):
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk or len(buffer) > 1024*1024:
                            break
                        buffer += chunk
                        while b'\n' in buffer:
                            line, buffer = buffer.split(b'\n', 1)
                            msg = json.loads(line)
                            if agent == 'codex' and msg.get('id') == 1 and 'result' in msg:
                                send(dict(method='initialized'))
                                send(dict(method='account/read', params={'refreshToken':False}, id=2) if identity else dict(method='account/rateLimits/read', id=2))
                            if agent == 'codex' and msg.get('id') == 2:
                                return msg.get('result') or {}
                            if agent == 'claude' and msg.get('type') == 'control_response':
                                response = msg.get('response', {})
                                if response.get('request_id') == 'limits':
                                    return response.get('response') or {}
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        process.kill()
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {}


def read_limits(agent):
    return windows(agent, control_result(agent), time.time())


def codex_identity():
    # Display only account metadata returned by the CLI; never read credential files.
    account = control_result('codex', identity=True).get('account')
    if not isinstance(account, dict) or account.get('type') != 'chatgpt':
        return ''
    email = account.get('email')
    workspace = account.get('workspaceName')
    return ' · '.join(filter(None, [
        email if isinstance(email, str) and len(email) <= 254 and email.isprintable() and '@' in email else '',
        workspace if isinstance(workspace, str) and len(workspace) <= 160 and workspace.isprintable() else '',
    ]))


def snapshot(agents):
    supported = [a for a in ('claude', 'codex') if a in agents]
    with ThreadPoolExecutor(max_workers=2) as pool:
        limits = dict(zip(supported, pool.map(read_limits, supported)))
    return dict(checkedAt=int(time.time()), agents=limits)
