"""Two queued legacy nudges must each retain their own completed turn."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from session_lifecycle import recover_codex_followups
from visible_session import load, save

with TemporaryDirectory() as temp:
    root = Path(temp)
    owner = dict(agent='codex',folder='/fixture',session='thread',mode='ask')
    jobs = [root / f'{i}.job' for i in range(3)]
    save(jobs[0],owner)
    transcript = root / 'thread.jsonl'
    events = []
    for i, prompt in enumerate(['Check mobile','Report the commit'],1):
        save(jobs[i],dict(owner,mode='nudge',outgoing=prompt))
        receipt = jobs[i].with_suffix('.receipt')
        save(receipt,dict(state='Delivered'))
        os.utime(receipt,(100,100))
        for kind, entry in [('event_msg',dict(type='task_started',turn_id=str(i))),
                            ('response_item',dict(type='message',role='user',content=[dict(text=prompt)])),
                            ('event_msg',dict(type='task_complete',turn_id=str(i),last_agent_message='Answer '+str(i)))]:
            events.append(json.dumps(dict(type=kind,payload=entry,timestamp=datetime.fromtimestamp(200+i,timezone.utc).isoformat())))
    with patch('session_lifecycle.conversation_path',return_value=transcript):
        transcript.write_text('\n'.join(events[:-1])+'\n')
        recover_codex_followups(root,owner,jobs)
        assert load(jobs[1].with_suffix('.receipt'))['message']=='Answer 1'
        assert load(jobs[2].with_suffix('.receipt'))['state']=='Delivered'
        transcript.write_text('\n'.join(events)+'\n')
        recover_codex_followups(root,owner,jobs)
        assert load(jobs[2].with_suffix('.receipt'))['message']=='Answer 2'
print('Independent completion receipts for consecutive queued nudges passed.')
