"""Focused checks for protocol parameters, socket startup, and denied-access behavior."""
from pathlib import Path
import os
import shlex
import tempfile
import uuid
from unittest.mock import Mock, patch
import cmux_host as host

ok=Mock(returncode=0, stdout='PONG', stderr='')
denied=Mock(returncode=1, stdout='', stderr='Access denied - only processes started inside cmux can connect')
missing=Mock(returncode=1, stdout='', stderr='Socket not found at /tmp/example.sock')

with tempfile.TemporaryDirectory() as directory:
    base=Path(directory)
    app=base/'The chosen cmux.app'
    cli=app/'Contents/Resources/bin/cmux'
    cli.parent.mkdir(parents=True)
    cli.touch(mode=0o700)
    with patch.dict(os.environ, {'TASKTAP_TERMINAL_APP':str(app)}), patch.object(host,'call',return_value=ok) as call:
        cmd=['/absolute/fake-runner','present',"a path '$x'; echo unsafe"]
        host.open_terminal(cmd,base,'Tasktap · one',base)
        args=call.call_args.args[1]
        assert args[0]=='new-workspace' and args[args.index('--cwd')+1]==directory
        assert shlex.split(args[args.index('--command')+1])==['exec',*cmd]
        assert call.call_args.args[0]==str(cli)
    with patch.object(host,'call',return_value=denied) as call, patch.object(host.subprocess,'run') as launch:
        try:host.require_connection(str(cli),str(app))
        except ValueError as error:assert 'from a cmux terminal' in str(error)
        else:raise AssertionError('Skipped socket authentication')
        assert call.call_count==1 and launch.call_count==0
    isolated_env={k:v for k,v in os.environ.items() if k!='CMUX_SOCKET_PATH'}
    with patch.dict(os.environ,isolated_env,clear=True), patch.object(host,'call',side_effect=[missing,missing,ok]) as call, patch.object(host.subprocess,'run') as launch:
        host.require_connection(str(cli),str(app))
        launch.assert_called_once()
        assert call.call_count==3 and list(launch.call_args.args[0])==['/usr/bin/open','-g','-a',str(app)]
    with patch.dict(os.environ,{'CMUX_SOCKET_PATH':'/private/test.sock'}), patch.object(host,'call',return_value=missing), patch.object(host.subprocess,'run') as launch:
        try:host.require_connection(str(cli),str(app))
        except ValueError as error:assert 'configured cmux socket' in str(error)
        else:raise AssertionError('Opened an unrelated cmux instance')
        launch.assert_not_called()
    ids=dict(surface=str(uuid.uuid4()),workspace=str(uuid.uuid4()))
    with patch.object(host,'installed',return_value=(str(cli),str(app))), patch.object(host,'call',return_value=ok) as call, patch.object(host.subprocess,'run') as launch:
        host.focus_terminal(ids)
        assert call.call_args.args[1]==['focus-panel','--panel',ids['surface'],'--workspace',ids['workspace']]
        launch.assert_called_once()
print('cmux exact surface, shell quoting, restricted socket and cold launch checks passed.')
