"""Paid-account gates and quota parsing using disposable credentials and transport fixtures."""
import base64
import json
from pathlib import Path
import tempfile
import time
import sys
from plan_usage import discover, gemini, cursor, grok, glm, quota

now=time.time()
future='2099-01-01T00:00:00Z'
with tempfile.TemporaryDirectory() as folder:
    home=Path(folder)
    def put(path,value):
        p=home/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
    calls=[]
    responses={}
    def get(url, token='', **kw):
        calls.append((url,token,kw))
        return responses[url]
    assert discover(home,{},get)=={} and not calls, 'Installation without credentials never shows a subscription or makes requests'
    agy_payload={'status':'SUCCESS','command':{'name':'usage','data':{'groups':[{'name':'Gemini Models','buckets':[{'id':'gemini-weekly','window':'weekly','remaining_fraction':.27,'reset_time':future},{'id':'gemini-5h','window':'5h','remaining_fraction':1,'reset_time':future}]}]}}}
    from plan_usage import parse_agy_usage
    parsed=parse_agy_usage(agy_payload,'Google AI Ultra')
    assert parsed['plan']=='Google AI Ultra · agy' and [w['remaining'] for w in parsed['windows']]==[27,100]
    assert parse_agy_usage({'status':'ERROR'},'Google AI Ultra') is None
    (home/'.gemini/antigravity-cli').mkdir(parents=True)
    bindir=home/'bin';bindir.mkdir();binary=bindir/'agy'
    binary.write_text('#!'+sys.executable+'\nimport sys,json,time\nif "--version" in sys.argv: print("1.5.9")\nelif "-p" in sys.argv: print('+repr(json.dumps(agy_payload))+')\nelse: print("(Google AI Ultra)",flush=True); time.sleep(20)\n')
    binary.chmod(0o700)
    actual=gemini(home,{'PATH':str(bindir)},get)
    assert actual==parsed
    binary.write_text('#!'+sys.executable+'\nprint("0.9.0")\n')
    assert gemini(home,{'PATH':str(bindir)},get) is None, 'Old CLI versions cannot run /usage as a model turn'
    jwt='e30.'+base64.urlsafe_b64encode(json.dumps({'sub':'auth0|fixture-user','exp':now+3600}).encode()).decode().rstrip('=')+'.signature'
    put('.config/cursor/auth.json',{'accessToken':jwt})
    endpoint='https://cursor.com/api/usage-summary'
    responses[endpoint]={'membershipType':'free'}
    assert cursor(home,{},get) is None
    responses[endpoint]={'membershipType':'pro','billingCycleStart':'2026-11-01T00:00:00Z','billingCycleEnd':future,'individualUsage':{'plan':{'used':25,'limit':100}}}
    c=cursor(home,{},get);assert c['plan']=='pro' and c['windows'][0]['remaining']==75
    assert 'fixture-user%3A%3A' in calls[-1][2]['headers']['Cookie']
    put('.grok/auth.json',{'https://auth.x.ai::fixture':{'key':'fixture-grok-token','expires_at':future}})
    settings='https://cli-chat-proxy.grok.com/v1/settings'
    billing='https://cli-chat-proxy.grok.com/v1/billing?format=credits'
    responses[settings]={'subscription_tier_display':'Free'}
    assert grok(home,{},get) is None
    responses[settings]={'subscription_tier_display':'SuperGrok'}
    responses[billing]={'config':{'creditUsagePercent':45,'currentPeriod':{'start':'2026-11-01T00:00:00Z','end':future}}}
    assert grok(home,{},get)['windows'][0]['remaining']==55
    assert glm(home,{},get) is None
    put('.claude/settings.json',{'env':{'ANTHROPIC_BASE_URL':'https://unrelated.example/api/coding/','ANTHROPIC_AUTH_TOKEN':'fixture-other-provider'}})
    before=len(calls);assert glm(home,{},get) is None and len(calls)==before
    put('.claude/settings.json',{'env':{'ANTHROPIC_BASE_URL':'https://api.z.ai/api/anthropic','ANTHROPIC_AUTH_TOKEN':'fixture-zai'}})
    # Official Claude Coding Plan config uses /api/anthropic, not an OpenAI /coding endpoint.
    z='https://api.z.ai/api/monitor/usage/quota/limit'
    responses[z]={'success':True,'code':200,'data':{'limits':[{'type':'TOKENS_LIMIT','unit':3,'number':5,'percentage':30,'nextResetTime':(now+7200)*1000},{'type':'TOKENS_LIMIT','unit':6,'number':1,'percentage':65,'nextResetTime':(now+172800)*1000}]}}
    out=glm(home,{'Z_AI_API_KEY':'fixture-zai'},get);assert [w['minutes'] for w in out['windows']]==[300,10080]
    responses[z]={'success':False,'code':500};assert glm(home,{'Z_AI_API_KEY':'fixture-zai'},get) is None
    assert quota(float('nan'),future,300,'bad') is None
    assert quota(20,now-1,300,'expired') is None
    assert quota(True,future,300,'bad') is None
    def fail(*a,**kw):raise ValueError('secret credential must never escape')
    assert discover(home,{'Z_AI_API_KEY':'fixture'},fail)=={}
    responses[z]={'success':True,'code':200,'data':{'limits':[]}}
    assert glm(home,{'Z_AI_API_KEY':'fixture'},get) is None, 'API balance is not a subscription'
    assert all('generate' not in url and 'completions' not in url for url,_,_ in calls)
from unittest.mock import patch
import worker_usage
with patch('plan_usage.discover',return_value={}),patch('worker_usage.read_limits',return_value=[]),patch('worker_usage.control_result',return_value={'account':{'type':'chatgpt','planType':'free'}}):
    assert 'codex' not in worker_usage.snapshot(['codex'])['subscriptions']
with patch('plan_usage.discover',return_value={}),patch('worker_usage.read_limits',return_value=[]),patch('worker_usage.control_result',return_value={'account':{'type':'chatgpt','planType':'pro'}}):
    assert worker_usage.snapshot(['codex'])['subscriptions']['codex']['plan']=='pro'
print('PASS: subscription gates for Gemini/Cursor/Grok/GLM, free and API-only exclusion, provider windows, credential routing, expiry, malformed data and network failure.')
