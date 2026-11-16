"""Read subscription status and quota from existing provider logins; never runs a model.

Protocol references: CodexBar (MIT, see PROVIDER-NOTICES), Gemini CLI and the
Z.ai usage-query plugin. Credentials stay in this process and are never returned.
Unknown, free, expired and API-only accounts fail closed.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
import os
import pty
import select
import signal
import tempfile
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(url, token='', data=None, headers=None, form=False):
    headers = dict(headers or {})
    headers.update({'Accept': 'application/json', 'User-Agent': 'Tasktap/1.0.3'})
    if token:
        headers['Authorization'] = 'Bearer '+token
    body = None
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        body = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, data=body, headers=headers), timeout=8) as r:
        payload = r.read(1024*1024+1)
        if len(payload) > 1024*1024:
            raise ValueError('Oversized response')
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise ValueError('Invalid response')
        return result


def read_json(path):
    if not path.is_file() or path.stat().st_size > 1024*1024:
        return {}
    value = json.loads(path.read_text())
    return value if isinstance(value, dict) else {}


def stamp(value):
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except ValueError:
            return None
    return value if type(value) in (float, int) and math.isfinite(value) else None


def quota(used, reset, minutes, label):
    reset = stamp(reset)
    if type(used) not in (int, float) or not math.isfinite(used) or not 0 <= used <= 100 or not reset or reset <= time.time():
        return None
    return dict(remaining=round(100-used), resetsAt=int(reset), minutes=minutes, label=label)


def result(plan, rows):
    return dict(plan=str(plan)[:100], windows=[row for row in rows if row])


def parse_agy_usage(payload, plan):
    if payload.get('status') != 'SUCCESS' or (payload.get('command') or {}).get('name') != 'usage':
        return None
    rows=[]
    for group in ((payload.get('command') or {}).get('data') or {}).get('groups', []):
        name=group.get('name') or group.get('displayName') or ''
        if 'gemini' not in name.lower():
            continue
        for bucket in group.get('buckets', []):
            fraction=bucket.get('remaining_fraction', bucket.get('remainingFraction'))
            window=bucket.get('window')
            if bucket.get('disabled') or type(fraction) not in (int,float) or not 0 <= fraction <= 1:
                continue
            mins={'weekly':10080,'5h':300}.get(window)
            if mins:
                rows.append(quota((1-fraction)*100,bucket.get('reset_time',bucket.get('resetTime')),mins,'Gemini models · '+window))
    return result(plan+' · agy', rows) if any(rows) else None


def agy_paid_tier(binary, env, folder):
    master, slave=pty.openpty()
    child_env=dict(env,AGY_CLI_HIDE_LOGO='1',TERM='xterm-256color',NO_COLOR='1')
    process=None
    try:
        # Trust only this generated, empty directory for this invocation. Settings are not saved.
        process=subprocess.Popen([binary,'--settings',json.dumps({'trustedWorkspaces':[str(Path(folder).resolve())]})],cwd=folder,env=child_env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);slave=None
        data=b'';deadline=time.monotonic()+12
        while time.monotonic()<deadline and len(data)<200000:
            if select.select([master],[],[],.2)[0]:
                try:
                    chunk=os.read(master,65536)
                except OSError:
                    break
                if not chunk:
                    break
                data+=chunk
                text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',data.decode(errors='replace'))
                # Require the account tier marker. Never match "Pro" in a model name.
                match=re.search(r'\((Google AI (?:Pro|Ultra|Plus)|Gemini Enterprise (?:Standard|Plus)|Gemini Code Assist (?:Standard|Enterprise))\)',text)
                if match:
                    return match.group(1)
        return None
    finally:
        if slave is not None:
            os.close(slave)
        os.close(master)
        if process:
            try:
                os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);process.wait()


def gemini(home, env, get):
    # agy supersedes Gemini CLI for consumer subscriptions. Query its actual signed-in tier.
    if not (home/'.gemini/antigravity-cli').is_dir() or env.get('AGY_ADC_AUTH'):
        return None
    binary=shutil.which('agy',path=env.get('PATH','/usr/bin:/bin'))
    if not binary:
        return None
    version=subprocess.run([binary,'--version'],capture_output=True,text=True,timeout=3,env=env)
    match=re.search(r'\b(\d+)\.(\d+)\.(\d+)\b',version.stdout)
    if version.returncode or not match or tuple(map(int,match.groups())) < (1,1,11):
        return None  # Older agy releases could treat /usage as a model prompt.
    with tempfile.TemporaryDirectory(prefix='tasktap-quota-') as folder:
        folder=str(Path(folder).resolve())
        for name in ['open','xdg-open']:
            stub=Path(folder)/name;stub.write_text('#!/bin/sh\nexit 1\n');stub.chmod(0o700)
        child_env=dict(env,PATH=folder+':'+env.get('PATH','/usr/bin:/bin'),BROWSER=folder+'/open')
        plan=agy_paid_tier(binary,child_env,folder)
        if not plan:
            return None
        process=subprocess.Popen([binary,'-p','/usage','--output-format','json','--print-timeout','15s'],cwd=folder,env=child_env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            output,_=process.communicate(timeout=20)
            if process.returncode or len(output)>1024*1024:
                return None
            return parse_agy_usage(json.loads(output),plan)
        finally:
            try:
                os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait()


def cursor(home, env, get):
    token = None
    for path in [home/'.config/cursor/auth.json', home/'.cursor/auth.json']:
        token = read_json(path).get('accessToken')
        if token:
            break
    db = home/'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
    if not token and db.is_file():
        with sqlite3.connect(db.as_uri()+'?mode=ro', uri=True, timeout=1) as conn:
            row = conn.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1").fetchone()
            token = row[0] if row else None
    if isinstance(token,str) and token.startswith('cursor-safe-storage:'):
        helper = Path(__file__).resolve().parent/'plan-credentials'
        if not helper.is_file():
            return None
        decoded = subprocess.run([str(helper)],input=token.encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3)
        token = decoded.stdout.decode() if decoded.returncode == 0 else None
    if not isinstance(token,str):
        return None
    parts = token.split('.')
    if len(parts) != 3:
        return None
    identity = json.loads(base64.urlsafe_b64decode(parts[1]+'='*((4-len(parts[1])%4)%4)))
    if stamp(identity.get('exp')) is None or identity['exp'] <= time.time():
        return None
    subject = identity.get('sub')
    if not isinstance(subject,str) or not subject:
        return None
    user = subject.split('|')[-1]
    summary = get('https://cursor.com/api/usage-summary', headers={'Cookie':'WorkosCursorSessionToken='+urllib.parse.quote(user+'::'+token, safe='')})
    plan = summary.get('membershipType')
    if plan not in ['pro','pro_plus','pro-plus','ultra','business','enterprise','team','teams','unified_pro','unified_ultra','unified_teams']:
        return None
    usage = (summary.get('individualUsage') or {}).get('plan') or {}
    used = usage.get('totalPercentUsed')
    if used is None and type(usage.get('limit')) in (float,int) and usage['limit'] > 0 and type(usage.get('used')) in (float,int):
        used = usage['used']/usage['limit']*100
    start, end = stamp(summary.get('billingCycleStart')), stamp(summary.get('billingCycleEnd'))
    mins = int((end-start)/60) if start and end and end > start else 0
    return result(plan, [quota(used, end, mins, 'Billing cycle')])


def grok(home, env, get):
    auth = read_json(Path(env.get('GROK_HOME', str(home/'.grok')))/'auth.json')
    entries = [(scope, entry) for scope, entry in auth.items() if isinstance(entry,dict) and entry.get('key') and (scope.startswith('https://auth.x.ai::') or scope == 'https://accounts.x.ai/sign-in')]
    entries.sort(key=lambda item: not item[0].startswith('https://auth.x.ai::'))
    if not entries:
        return None
    entry = entries[0][1]
    expires = stamp(entry.get('expires_at'))
    if expires and expires <= time.time():
        return None
    headers = {'x-xai-token-auth':'xai-grok-cli'}
    settings = get('https://cli-chat-proxy.grok.com/v1/settings', entry['key'], headers=headers)
    plan = settings.get('subscription_tier_display')
    if not isinstance(plan,str) or re.sub(r'[^a-z]', '', plan.lower()) not in ['supergrok','supergrokheavy','heavy','pro','ultra','premium','premiumplus']:
        return None
    data = get('https://cli-chat-proxy.grok.com/v1/billing?format=credits', entry['key'], headers=headers).get('config') or {}
    period = data.get('currentPeriod') or {}
    end = stamp(period.get('end') or data.get('billingPeriodEnd'))
    start = stamp(period.get('start') or data.get('billingPeriodStart'))
    mins = int((end-start)/60) if end and start and end > start else 0
    return result(plan, [quota(data.get('creditUsagePercent'), end, mins, 'Plan allowance')])


def glm(home, env, get):
    token = env.get('Z_AI_API_KEY') or env.get('ZAI_API_KEY')
    base = 'https://api.z.ai'
    # Read only the existing Claude Coding Plan configuration, never send arbitrary keys upstream.
    config = {**(read_json(home/'.claude/settings.json').get('env') or {}), **{k:v for k,v in env.items() if k in ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY']}}
    url = urllib.parse.urlparse(config.get('ANTHROPIC_BASE_URL', ''))
    if not token and url.scheme == 'https' and url.hostname in ['api.z.ai','open.bigmodel.cn'] and (url.path.startswith('/api/anthropic') or '/coding/' in url.path):
        token = config.get('ANTHROPIC_AUTH_TOKEN') or config.get('ANTHROPIC_API_KEY')
        base = 'https://'+url.hostname
    if not isinstance(token,str) or not token:
        return None
    payload = get(base+'/api/monitor/usage/quota/limit', token)
    if payload.get('success') is not True or payload.get('code') != 200:
        return None
    limits = (payload.get('data') or {}).get('limits')
    if not isinstance(limits,list):
        return None
    rows = []
    confirmed = False
    for limit in limits:
        if not isinstance(limit,dict) or limit.get('type') not in ['TOKENS_LIMIT','CREDIT_LIMIT']:
            continue
        number, unit, used = limit.get('number'), limit.get('unit'), limit.get('percentage')
        if type(number) is not int or number <= 0 or unit not in {1:1440,3:60,5:1,6:10080} or type(used) not in (int,float) or not 0 <= used <= 100:
            continue
        confirmed = True
        mins = number*{1:1440,3:60,5:1,6:10080}[unit]
        reset = limit.get('nextResetTime')
        reset = reset/1000 if type(reset) in (float,int) else None
        rows.append(quota(used, reset, mins, 'Coding Plan'))
    return result('GLM Coding Plan', rows) if confirmed else None


def discover(home=None, env=None, get=request):
    home, env = Path(home or Path.home()), dict(os.environ if env is None else env)
    probes = {'gemini':gemini, 'cursor':cursor, 'grok':grok, 'glm':glm}
    def run(item):
        name, probe = item
        try:
            return name, probe(home, env, get)
        except Exception:
            # Never leak provider payloads or credentials in error messages.
            return name, None
    with ThreadPoolExecutor(max_workers=4) as pool:
        return {name:value for name,value in pool.map(run, probes.items()) if value}
