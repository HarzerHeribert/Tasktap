"""Offline checkpoint, truncation, unseen-output and session-reuse checks."""
from pathlib import Path
import tempfile
import terminal_replay as replay

with tempfile.TemporaryDirectory(prefix='tasktap-replay-test-') as directory:
    path=Path(directory)/'history.json';record=replay.Replay(path)
    record.reconcile(b'first\n',120,30,1,1)
    record.resize(50,24)
    record.append(b'second\n',2)
    restored=replay.Replay(path)
    restored.reconcile(record.data+b'unseen\n',50,24,3,1)
    assert restored.sizes==[dict(offset=0,cols=120,rows=30),dict(offset=6,cols=50,rows=24)]
    assert path.stat().st_mode&0o077==0
    # The PTY retained only a suffix; keep the grid active at the cut boundary.
    restored.reconcile(b'second\nunseen\nnew\n',50,24,4,1)
    assert restored.sizes==[dict(offset=0,cols=50,rows=24)]
    # An unrelated/new stream cannot inherit old screen geometry.
    restored.reconcile(b'first\n',80,20,1,2)
    assert restored.sizes==[dict(offset=0,cols=80,rows=20)]
    replay.LIMIT=16
    restored.resize(40,10);restored.append(b'0123456789\nABCDEFGH\n',2)
    assert len(restored.data)<=16 and restored.sizes[0]['offset']==0
    assert restored.sizes[0]['cols']==40
    path.write_text('broken checkpoint')
    fallback=replay.Replay(path);fallback.reconcile(b'intact\n',90,25,8,1)
    assert fallback.data==b'intact\n' and fallback.sizes[0]['cols']==90
print('PASS: replay geometry, unseen output, truncation, session reuse, private bounded storage and corrupt-checkpoint recovery.')
