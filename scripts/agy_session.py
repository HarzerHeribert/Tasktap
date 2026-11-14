"""One Antigravity turn over its native Agent Client Protocol."""
import json
import subprocess
from pathlib import Path

def run(cli,job,previous,bridge,prompt,save_id):
    mcp=dict(bridge,name='workspace_assistant',env=[])
    current=previous
    text=[]
    with subprocess.Popen([cli,'acp'],cwd=job['folder'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True) as proc:
        def send(message):
            proc.stdin.write(json.dumps(dict(jsonrpc='2.0',**message))+'\n');proc.stdin.flush()
        def call(i,method,params):
            send(dict(id=i,method=method,params=params))
            for line in proc.stdout:
                event=json.loads(line)
                if event.get('id')==i and 'method' not in event:
                    if 'error' in event:raise ValueError(str(event['error'].get('message','Agent error')))
                    return event.get('result',{})
                p=event.get('params',{})
                if event.get('method')=='session/update':
                    u=p.get('update',{})
                    if u.get('sessionUpdate')=='agent_message_chunk' and u.get('content',{}).get('type')=='text':
                        text.append(u['content']['text'])
                elif event.get('method')=='session/request_permission':
                    opts=[o for o in p.get('options',[]) if o.get('kind') in ('allow_once','reject_once')]
                    outcome={'outcome':'cancelled'}
                    if opts:
                        command=[str(Path(bridge['command']).with_name('ask-user')),*bridge['args'],'--request',str(current)+'-'+str(event['id'])+'-'+str(job['capture']),'--question',p.get('toolCall',{}).get('title','Allow this operation?')]
                        for o in opts:command+=['--choice',o['name']]
                        if len(opts)>=2:
                            result=subprocess.run(command,stdout=subprocess.PIPE,text=True)
                            if result.returncode==0:
                                answer=json.loads(result.stdout.splitlines()[-1])['answer']
                                selected=next(o for o in opts if o['name']==answer)
                                outcome={'outcome':'selected','optionId':selected['optionId']}
                    send(dict(id=event['id'],result={'outcome':outcome}))
                elif 'id' in event and 'method' in event:
                    send(dict(id=event['id'],error={'code':-32601,'message':'Unsupported client method'}))
            raise ValueError('Antigravity disconnected before completing this turn.')
        try:
            call(1,'initialize',dict(protocolVersion=1,clientCapabilities={}))
            params=dict(cwd=job['folder'],mcpServers=[mcp])
            if previous:call(2,'session/load',dict(params,sessionId=previous))
            else:
                current=call(2,'session/new',params)['sessionId'];save_id(current)
            text.clear()  # session/load may replay the preceding conversation.
            answer=call(3,'session/prompt',dict(sessionId=current,prompt=[{'type':'text','text':prompt}]))
            if answer.get('stopReason')!='end_turn':raise ValueError('Antigravity stopped: '+str(answer.get('stopReason')))
            return ''.join(text) or 'Turn completed.'
        finally:
            proc.terminate()
