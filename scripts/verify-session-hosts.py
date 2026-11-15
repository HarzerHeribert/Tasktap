"""Regressions for launch-backed cmux discovery and Claude Desktop preparation."""
import json
from pathlib import Path
import tempfile
import uuid
from unittest.mock import Mock, patch
from urllib.parse import urlparse, parse_qs
import claude_desktop
import cmux_sessions

with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp).resolve(); project=root/'project'; project.mkdir()
    record=dict(agent='codex',cwd=str(project),session_id=str(uuid.uuid4()),surface_id=str(uuid.uuid4()),workspace_id=str(uuid.uuid4()),stored_pid_exists=True,active_for_surface=False,launch_backed=True)
    def discover(**extra):
        with patch.object(cmux_sessions,'cmux_cli',return_value='cmux'), patch.object(cmux_sessions.subprocess,'run',return_value=Mock(stdout=json.dumps({'sessions':[{**record,**extra}]}))):
            return cmux_sessions.sessions(root,allow_external=True)
    row=discover()[0]
    assert row['host']=='cmux' and row['inbox']=='manual' and row['workspace']==record['workspace_id']
    assert not discover(stored_pid_exists=False)
    assert not discover(active_surface_session_id=str(uuid.uuid4()))
    assert discover(active_for_surface=True)[0]['inbox']=='cmux'
    with patch.object(cmux_sessions.subprocess,'run') as run:
        try:cmux_sessions.send_inbox(row,'hello')
        except ValueError:pass
        else:raise AssertionError('Unconfirmed inbox accepted a message')
        run.assert_not_called()
    job=dict(agent='claude',mode='ask',folder=str(project),outgoing='Review a & b? # café\nDo not lose this line.')
    assert parse_qs(urlparse(claude_desktop.brief_url(job)).query)=={'q':[job['outgoing']],'folder':[str(project)]}
    for invalid in ({**job,'agent':'codex'},{**job,'mode':'nudge'},{**job,'outgoing':'x'*14001}):
        try:claude_desktop.brief_url(invalid)
        except ValueError:pass
        else:raise AssertionError('Invalid handoff accepted')
    with patch.object(claude_desktop.subprocess,'run') as run:
        claude_desktop.prepare(root/'test.job',job)
        assert run.call_args.args[0]==['/usr/bin/open',claude_desktop.brief_url(job)]
        assert json.loads((root/'test.receipt').read_text())['state']=='Prepared'
    runs=root/'Runs'; run_dir=runs/str(uuid.uuid4()); run_dir.mkdir(parents=True)
    owned_job={**job,'host':'claude-desktop','session':run_dir.name,'task':'Review folder'}
    (run_dir/'1.job').write_text(json.dumps(owned_job))
    (run_dir/'surface.json').write_text(json.dumps({'host':'claude-desktop','open':False}))
    restored=list(cmux_sessions.owned_rows(root,runs,[]))
    assert restored[0]['state']=='Ready to send' and restored[0]['inbox']=='manual'
print('Session host discovery and Claude Desktop preparation checks passed.')
