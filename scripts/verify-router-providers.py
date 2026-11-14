"""Offline fixtures for capture preparation providers and the sign-in callback."""
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import urlopen


module = SourceFileLoader('router_provider', str(Path(__file__).with_name('router-provider')))
spec = importlib.util.spec_from_loader(module.name, module)
provider = importlib.util.module_from_spec(spec)
module.exec_module(provider)

assert provider.cloud_provider({'CLAUDE_CODE_USE_BEDROCK':'true'}) == 'Amazon Bedrock'
assert not provider.cloud_provider({'CLAUDE_CODE_USE_BEDROCK':'1','CLAUDE_CODE_USE_VERTEX':'true'})

def inspect_agents(available, responses, env=None):
    def run(args, **_):
        reply = responses[tuple(args)]
        if isinstance(reply, Exception):
            raise reply
        return subprocess.CompletedProcess(args, *reply)
    with patch.dict(os.environ, env or {}, clear=True), patch.object(provider.shutil, 'which', side_effect=available.get), patch.object(provider.subprocess, 'run', side_effect=run):
        return provider.worker_status()

codex_check = ('codex','login','status')
claude_check = ('claude','auth','status','--json')
agents = {name:'/bin/'+name for name in ('codex','claude','agy')}
assert set(inspect_agents({}, {})['workerHealth'].values()) == {'missing'}
result = inspect_agents(agents, {codex_check:(0,'','Logged in using ChatGPT'), claude_check:(0,'{"loggedIn":true,"authMethod":"oauth","subscriptionType":"pro"}','')})
assert result['workerHealth'] == {'pi':'missing','cursor-agent':'missing','codex':'signedIn','claude':'signedIn','agy':'installed'}
assert result['workers']['codex'] == 'ChatGPT login' and result['workers']['claude'] == 'Claude plan login'
responses = {codex_check:(1,'','Not logged in'), claude_check:(1,'{"loggedIn":false}','')}
assert inspect_agents(agents, responses)['workerHealth'] == {'pi':'missing','cursor-agent':'missing','codex':'signedOut','claude':'signedOut','agy':'installed'}
assert inspect_agents(agents, responses, {'CLAUDE_CODE_USE_VERTEX':'1','GEMINI_API_KEY':'fixture'})['workerHealth'] == {'pi':'missing','cursor-agent':'missing','codex':'signedOut','claude':'configured','agy':'configured'}
result = inspect_agents(agents, {codex_check:subprocess.TimeoutExpired(codex_check,4), claude_check:(1,'invalid','')})
assert result['workerHealth'] == {'pi':'missing','cursor-agent':'missing','codex':'unknown','claude':'unknown','agy':'installed'}
optional = {'cursor-agent':'/bin/cursor-agent','pi':'/bin/pi'}
result = inspect_agents(optional, {('cursor-agent','status','--format','json'):(1,'{"isAuthenticated":false}','')})
assert result['workerHealth']['cursor-agent']=='signedOut' and result['workerHealth']['pi']=='installed'

from worker_usage import windows, codex_identity
with patch('worker_usage.control_result',return_value={'account':{'type':'chatgpt','email':'me@example.test','workspaceName':'Studio','accessToken':'irrelevant'}}) as read:
    assert codex_identity()=='me@example.test · Studio'
    read.assert_called_once_with('codex', identity=True)
with patch('worker_usage.control_result',return_value={'account':{'type':'apiKey','email':'ignore@example.test'}}):
    assert codex_identity()==''

before = 1000
data = {'rateLimitsByLimitId':{'codex':{'primary':{'usedPercent':99,'windowDurationMins':300,'resetsAt':1400},
                                      'secondary':{'usedPercent':5,'windowDurationMins':10080,'resetsAt':2000}}}}
assert [w['remaining'] for w in windows('codex',data,before)] == [1,95]
assert [w['remaining'] for w in windows('codex',data,1400)] == [95]
assert windows('claude',{'rate_limits':{'five_hour':{'utilization':True,'resets_at':1500},
                                        'seven_day':{'utilization':98,'resets_at':'2026-11-16T22:00:00Z'}}},before)[0]['remaining']==2
assert windows('codex',{'rateLimits':{'limitId':'unrelated','primary':{'usedPercent':5,'resetsAt':2000}}},before)==[]
with patch.object(provider.shutil,'which',return_value='/Applications/Codex CLI/codex'), patch.object(provider.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as launch:
    provider.worker_login({'agent':'codex'})
    assert launch.call_args.args[0][-1] == "exec '/Applications/Codex CLI/codex' login"
    try:
        provider.worker_login({'agent':'anything else'})
        raise AssertionError('Unsupported sign-in action')
    except ValueError:
        assert launch.call_count == 1

with tempfile.TemporaryDirectory() as directory:
    for route, executable in [('codex','codex'), ('cloud','claude')]:
        cli=Path(directory)/executable
        cli.write_text('''#!/usr/bin/env python3
import json,sys
from pathlib import Path
a=sys.argv[1:]
assert 'fixture capture' in sys.stdin.read()
if '--output-schema' in a:
    assert '--ignore-user-config' in a and '--ephemeral' in a
    Path(a[a.index('-o')+1]).write_text('{"brief":"ok"}')
else:
    assert '--bare' in a and a[a.index('--tools')+1]==''
    print('{"structured_output":{"brief":"ok"}}')
''')
        cli.chmod(0o700)
        with patch.dict(os.environ, {'PATH':directory+':'+os.environ['PATH'],'CLAUDE_CODE_USE_VERTEX':'1'}):
            assert provider.cli_route(dict(route=route,model='',schema={},prompt='fixture capture'))=={'brief':'ok'}

# Exercise the real loopback listener with a simulated browser. No provider contact.
def callback(argv, **_):
    q=parse_qs(urlsplit(argv[1]).query)
    assert q['client_id']==['dynamic_agent_client'] and q['code_challenge_method']==['S256']
    url=q['redirect_uri'][0]+'?'+urlencode(dict(state=q['state'][0],code='fixture',client_id='issued'))
    threading.Thread(target=lambda: urlopen(url,timeout=4).close()).start()
with patch.object(provider.subprocess,'run',side_effect=callback):
    result=provider.browser_login(dict(host='urn:uuid:test'))
assert result['client']=='issued' and result['code']=='fixture' and result['nonce'] and result['verifier']
print('Agent status and sign-in actions, capture routing, cloud detection and OAuth loopback passed.')
