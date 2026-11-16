#!/usr/bin/env python3
"""Exercise model arguments and ACP selection without launching paid agent turns."""
import json
import os
import sqlite3
import tempfile
import uuid
from session_models import conversation_model, last_transcript_model
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import agy_session

from visible_session import cli_command

base=dict(agent='codex',session='conversation',folder='/tmp',task='test',outgoing='reviewed prompt',instructions='fixture',model='selected',capture='test')
with tempfile.TemporaryDirectory() as directory:
    checkout=Path(directory).resolve()/'My "café".repo'
    checkout.mkdir()
    job=dict(base,folder=str(checkout),reviewedFolder=str(checkout),mode='ask')
    argv=cli_command(job,checkout,'/agent')
    assert '--approve-for-me' in argv and not any('dangerously' in a for a in argv)
    override=next(a for a in argv if a.startswith('projects='))
    assert override=='projects={'+json.dumps(str(checkout),ensure_ascii=False)+'={trust_level="trusted"}}'
    legacy=cli_command(base,checkout,'/agent')
    assert legacy.count('--approve-for-me')==1 and not any(a.startswith('projects=') for a in legacy)
    other_job=dict(job,folder=str(checkout.parent))
    try:cli_command(other_job,checkout,'/agent')
    except ValueError:pass
    else:raise AssertionError('Trust carried over to a different folder')
    claude=cli_command(dict(job,agent='claude'),checkout,'/agent')
    assert claude[claude.index('--permission-mode')+1]=='auto' and not any(a.startswith('projects=') for a in claude)
    assert not any('dangerously' in a for a in claude)
for provider in ('codex','claude','agy','cursor-agent','pi','opencode'):
    job=dict(base,agent=provider)
    fresh=cli_command(job,Path('/tools'),'/agent')
    if provider=='codex':
        assert fresh[-1]==base['outgoing']+'\n\n'+base['instructions']
    if provider=='claude':
        assert fresh[fresh.index('--permission-mode')+1]=='auto'
    if provider=='cursor-agent':
        assert fresh[-2:]==['--',base['outgoing']] and '--auto-review' in fresh
        assert not {'--trust','--approve','--force','--yolo'}.intersection(fresh)
    if provider=='pi':
        # Pi's --approve trusts project-local resources for this invocation;
        # it is not a claim that Pi has a classifier-based tool approval mode.
        assert fresh[-2:]==['--',base['outgoing']] and '--approve' in fresh
        assert not {'--trust','--force','--yolo'}.intersection(fresh)
    if provider=='opencode':
        assert fresh[-2:]==['--prompt',base['outgoing']] and '--auto' in fresh
    assert fresh[fresh.index('--model')+1]=='selected'
    assert '--model' not in cli_command(dict(job,model=''),Path('/tools'),'/agent')
    assert not {'--print','exec','acp','app-server'}.intersection(fresh)
    for bad in ('--bad','bad\nmodel',['bad']):
        try: cli_command(dict(job,model=bad),Path('/tools'),'/agent')
        except ValueError: pass
        else: raise AssertionError('Invalid model accepted')

with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    for provider in ('codex','claude','pi','opencode'):
        folder=root/provider;folder.mkdir()
        observed=dict(base,agent=provider,session=str(uuid.uuid4()),observer=True,host='tasktap')
        fresh=cli_command(observed,folder,'/agent')
        assert fresh[fresh.index('--model')+1]=='selected'
        assert not any('mcp_servers' in arg or arg=='--mcp-config' for arg in fresh)
        assert fresh[-1]==base['outgoing'] and base['instructions'] not in fresh[-1]
        assert not {'--force','--yolo','--dangerously-skip-permissions'}.intersection(fresh)
        if provider=='codex':assert '--approve-for-me' in fresh
        if provider=='claude':assert fresh[fresh.index('--permission-mode')+1]=='auto'
        if provider=='pi':assert '--approve' in fresh
        if provider=='opencode':assert '--auto' in fresh

calls=[]
def call(*args):
    calls.append(args)
session=dict(sessionId='session',configOptions=[dict(id='provider-model',category='model',options=[dict(group='gemini',options=[dict(value='gemini',name='Gemini')])])])
agy_session.select_model(call,session,'gemini')
assert calls[-1] == (4,'session/set_config_option',dict(sessionId='session',configId='provider-model',value='gemini'))
agy_session.select_model(call,dict(sessionId='session',models=dict(availableModels=[dict(modelId='exact-high',name='Exact High')])), 'exact-high')
assert calls[-1] == (4,'session/set_model',dict(sessionId='session',modelId='exact-high'))
try:
    agy_session.select_model(call,session,'missing')
except ValueError as error:
    assert 'does not offer' in str(error)
else:
    raise AssertionError('Unavailable model accepted')

# An ACP resume must never issue either model-setting method, even if a stale job has a model.
class Pipe:
    def __init__(self, proc):
        self.proc=proc
    def write(self,text):
        message=json.loads(text);self.proc.sent.append(message)
        result={'sessionId':'same'}
        if message['method']=='session/prompt':result={'stopReason':'end_turn'}
        self.proc.events.append(json.dumps(dict(id=message['id'],result=result))+'\n')
    def flush(self):pass
    def __iter__(self):return self
    def __next__(self):
        if self.proc.events:return self.proc.events.pop(0)
        raise StopIteration
class Process:
    def __init__(self,*args,**kwargs):
        self.sent=[];self.events=[];self.stdin=Pipe(self);self.stdout=Pipe(self)
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def terminate(self):pass
proc=Process()
with patch.object(agy_session.subprocess,'Popen',return_value=proc):
    agy_session.run('/agy',base,'same',dict(command='/tools',args=[]),'follow up',lambda *_:None,'different')
assert [m['method'] for m in proc.sent]==['initialize','session/load','session/prompt']
# A conversational reply is not one of ACP's permission options. It must cancel
# the operation cleanly, while an explicit matching choice still works.
class PermissionPipe(Pipe):
    def write(self, text):
        message=json.loads(text)
        if 'method' not in message:
            self.proc.sent.append(message)
            return
        if message['method']=='session/prompt':
            self.proc.events.append(json.dumps(dict(id=90,method='session/request_permission',params=dict(options=[
                dict(name='Allow once',kind='allow_once',optionId='allow'),
                dict(name='Reject',kind='reject_once',optionId='reject')
            ])))+'\n')
        super().write(text)
for answer, expected in [('Why is this needed?', {'outcome':'cancelled'}), ('Allow once', {'outcome':'selected','optionId':'allow'})]:
    proc=Process();proc.stdin=PermissionPipe(proc)
    reply=SimpleNamespace(returncode=0,stdout=json.dumps(dict(answer=answer)))
    with patch.object(agy_session.subprocess,'Popen',return_value=proc), patch.object(agy_session.subprocess,'run',return_value=reply):
        agy_session.run('/agy',base,'same',dict(command='/tools',args=[]),'follow up',lambda *_:None)
    assert next(m['result']['outcome'] for m in proc.sent if m['id']==90)==expected
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    session=str(uuid.uuid4())
    with sqlite3.connect(root/'state_5.sqlite') as db:
        db.execute('CREATE TABLE threads (id TEXT, model TEXT, rollout_path TEXT)')
        db.execute('INSERT INTO threads VALUES (?,?,?)',(session,'last-codex-model',''))
    with patch.dict(os.environ,{'CODEX_HOME':folder}):
        assert conversation_model('codex',session)=='last-codex-model'
    path=root/'projects'/'workspace'/(session+'.jsonl')
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(dict(type='assistant',message=dict(model='first')))+'\n'+
                    json.dumps(dict(type='user',text='x'*140000))+'\n'+
                    json.dumps(dict(type='assistant',message=dict(model='last-claude-model')))+'\n'+
                    json.dumps(dict(type='assistant',message=dict(model='<synthetic>')))+'\n')
    with patch.dict(os.environ,{'CLAUDE_CONFIG_DIR':folder}):
        assert conversation_model('claude',session)=='last-claude-model'
    path.write_text(json.dumps(dict(type='turn_context',payload=dict(model='from-context')))+'\n'+
                    json.dumps(dict(type='user',text='x'*140000))+'\n')
    assert last_transcript_model(path,'codex')=='from-context'
print('Interactive provider model flags, invalid model IDs, stored model lookups and legacy ACP selection passed.')
