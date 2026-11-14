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
import agy_session

from visible_session import cli_command

base=dict(agent='codex',session='conversation',folder='/tmp',task='test',outgoing='reviewed prompt',instructions='fixture',model='selected',capture='test')
for provider in ('codex','claude','agy'):
    job=dict(base,agent=provider)
    fresh=cli_command(job,Path('/tools'),'/agent')
    assert fresh[fresh.index('--model')+1]=='selected'
    assert '--model' not in cli_command(dict(job,model=''),Path('/tools'),'/agent')
    assert not {'--print','exec','acp','app-server'}.intersection(fresh)
    for bad in ('--bad','bad\nmodel',['bad']):
        try: cli_command(dict(job,model=bad),Path('/tools'),'/agent')
        except ValueError: pass
        else: raise AssertionError('Invalid model accepted')

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
