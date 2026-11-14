import json
from pathlib import Path
from tempfile import TemporaryDirectory
from session_activity import excerpt

with TemporaryDirectory() as temp:
    path=Path(temp)/'session.jsonl'
    events=[{'type':'event_msg','payload':{'type':'user_message','message':'Improve the updater'}},
            {'type':'response_item','payload':{'type':'reasoning','summary':[{'text':'PRIVATE REASONING'}]}},
            {'type':'assistant','message':{'content':[{'type':'thinking','thinking':'PRIVATE THINKING'},{'type':'tool_use','input':{'secret':'SECRET TOOL INPUT'}}]}},
            {'type':'user','message':{'content':[{'type':'tool_result','content':'SECRET TOOL OUTPUT'}]}},
            {'type':'event_msg','payload':{'type':'agent_message','message':'Testing installation and relaunch'}}]
    path.write_text('\n'.join(map(json.dumps,events))+'\n')
    result=excerpt(path)
    assert 'Improve the updater' in result and 'Testing installation' in result
    assert 'SECRET' not in result and 'PRIVATE' not in result
    modern={'type':'response_item','payload':{'type':'message','role':'assistant','phase':'commentary','content':[{'type':'output_text','text':'Verifying current session names'}]}}
    path.write_text(json.dumps(modern)+'\n');assert excerpt(path)=='Verifying current session names'
    modern['payload']['phase']='analysis';path.write_text(json.dumps(modern)+'\n');assert excerpt(path)==''
    path.write_text('x'*140000+'\n'+json.dumps(events[-1])+'\n{"incomplete":')
    assert excerpt(path)=='Testing installation and relaunch'
    assert excerpt(Path(temp)/'missing')==''
print('Bounded excerpts include public messages and exclude reasoning, tool input and output.')
