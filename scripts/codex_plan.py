"""Run one account-bound Codex turn with Tasktap's explicit ChatGPT plan grant."""
import json
import os
import subprocess
import sys


def approval(proc_request, bridge, job):
    method = proc_request['method']
    if method not in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
        return {'error':{'code':-32601,'message':'Unsupported client request'}}
    p = proc_request.get('params', {})
    command = p.get('command') or p.get('grantRoot') or p.get('reason') or ''
    helper = os.path.join(os.path.dirname(bridge['command']), 'ask-user')
    title = 'Allow this command?' if 'commandExecution' in method else 'Allow these file changes?'
    request = [helper, *bridge['args'], '--request', job['capture']+'-'+str(proc_request['id']),
               '--question', title, '--detail', str(command)[:4000], '--choice','Allow once','--choice','Decline']
    answer = 'decline'
    with subprocess.Popen(request, stdout=subprocess.PIPE, text=True) as session:
        for line in session.stdout:
            event = json.loads(line)
            if event.get('type') == 'answer':
                answer = 'accept' if event.get('answer') == 'Allow once' else 'decline'
                break
    return {'result':{'decision':answer}}


def run(cli, bridge, job, prompt, previous, model, save_id):
    # The native parent supplies a fresh bearer for each turn over private pipes.
    # Printing it, passing it in arguments, or storing it in a job would expose credentials.
    print(json.dumps({'account': job['planAccount']}), flush=True)
    grant = json.loads(sys.stdin.readline())
    if not grant.get('token'):
        raise ValueError(grant.get('error') or 'Reconnect the ChatGPT plan in Tasktap.')
    provider = 'model_providers.tasktap_plan.'
    config = {
        'mcp_servers':{}, 'model_provider':'tasktap_plan', provider+'name':'ChatGPT plan',
        provider+'base_url':'https://api.openai.com/v1', provider+'env_key':'TASKTAP_CODEX_ACCESS',
        provider+'wire_api':'responses', provider+'requires_openai_auth':False,
        provider+'supports_websockets':False, 'web_search':'disabled',
        'mcp_servers.workspace_assistant.command':bridge['command'],
        'mcp_servers.workspace_assistant.args':bridge['args'],
        'mcp_servers.workspace_assistant.tool_timeout_sec':86400,
    }
    args = [cli, 'app-server', '--listen', 'stdio://', '--disable', 'tool_search_always_defer_mcp_tools']
    for key, value in config.items():
        args.extend(['-c', key + '=' + json.dumps(value)])
    env = dict(os.environ, TASKTAP_CODEX_ACCESS=grant['token'])
    # Child commands must never inherit the plan bearer from the app-server environment.
    args.extend(['-c', 'shell_environment_policy.exclude=["*KEY*","*SECRET*","*TOKEN*","*PASS*","TASKTAP_CODEX_ACCESS"]'])
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, cwd=job['folder'], env=env) as proc:
        def send(body):
            proc.stdin.write(json.dumps(body)+'\n')
            proc.stdin.flush()

        def read():
            while True:
                line = proc.stdout.readline()
                if not line:
                    raise ValueError('Codex disconnected. Check plan access before retrying.')
                data = json.loads(line)
                if 'method' in data and 'id' in data:
                    send({'id':data['id'], **approval(data,bridge,job)})
                else:
                    return data

        def rpc(request_id, method, params):
            send({'id':request_id,'method':method,'params':params})
            while True:
                data = read()
                if data.get('id') == request_id:
                    if 'error' in data:
                        raise ValueError('Codex could not '+method+'. Check the plan connection and model.')
                    return data['result']

        try:
            rpc(1, 'initialize', {'clientInfo':{'name':'tasktap','title':'Tasktap','version':'0.2'}})
            send({'method':'initialized'})
            params = {'cwd':job['folder'],'modelProvider':'tasktap_plan','sandbox':'workspace-write','approvalPolicy':'on-request'}
            if model:
                params['model'] = model
            if previous:
                params['threadId'] = previous
            thread = rpc(2, 'thread/resume' if previous else 'thread/start', params)
            ident = thread['thread']['id']
            if previous and ident != previous:
                raise ValueError('Codex resumed a different conversation.')
            save_id(ident,thread.get('model') or model)
            turn = rpc(3,'turn/start',{'threadId':ident,'input':[{'type':'text','text':prompt}]})['turn']['id']
            result = ''
            while True:
                data = read()
                p = data.get('params',{})
                if p.get('threadId') != ident:
                    continue
                if data.get('method') == 'item/completed' and p.get('turnId') == turn:
                    item = p.get('item',{})
                    if item.get('type') == 'agentMessage':
                        result = item.get('text') or result
                if data.get('method') == 'turn/completed' and p.get('turn',{}).get('id') == turn:
                    if p['turn'].get('status') != 'completed' or not result.strip():
                        raise ValueError('The ChatGPT plan turn did not complete. Check model access and plan limits.')
                    return result
        finally:
            proc.terminate()
