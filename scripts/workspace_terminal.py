#!/usr/bin/env python3
"""Private local PTY service. Closing a client detaches; only stop ends a session.

No network listener, shell interpolation, or terminal-output command execution.
The stdio bridge is consumed by the native app; run-agent also uses request().
"""
import base64
import collections
import fcntl
import json
import os
from pathlib import Path
import pty
import selectors
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import uuid

ROOT = Path(os.environ.get('TASKTAP_TERMINAL_ROOT') or Path.home() / 'Library/Application Support/Tasktap/Terminals')
LIMIT = 2 * 1024 * 1024


def ident(value):
    return str(uuid.UUID(value))


def private_root():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    stat = ROOT.lstat()
    if ROOT.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise ValueError('Terminal storage must be a private directory owned by you.')
    return ROOT


def connect():
    path = str(private_root() / 'session.sock')
    for attempt in range(60):
        sock = socket.socket(socket.AF_UNIX)
        try:
            sock.connect(path)
            return sock
        except (FileNotFoundError, ConnectionRefusedError):
            sock.close()
            if attempt == 0:
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            time.sleep(.05)
    raise RuntimeError('The local terminal service did not start.')


def request(payload):
    with connect() as sock:
        sock.settimeout(10)
        sock.sendall(json.dumps(payload).encode() + b'\n')
        with sock.makefile('rb') as stream:
            # Replay is base64 encoded, so a full buffer exceeds LIMIT on wire.
            response = json.loads(stream.readline(LIMIT * 2))
    if response.get('error'):
        raise ValueError(response['error'])
    return response


class Service:
    def __init__(self):
        self.selector = selectors.DefaultSelector()
        self.sessions = {}
        self.clients = {}
        self.closing_workspaces = set()
        self.idle = time.monotonic()
        self.manifest = ROOT / 'sessions.json'
        self.lifecycle = ROOT / 'lifecycle.json'
        try:
            lifecycle = json.loads(self.lifecycle.read_text())
            self.closed_workspaces = set(lifecycle.get('closed', []))
            self.cancelled = set(lifecycle.get('cancelled', []))
        except (OSError, ValueError, TypeError):
            self.closed_workspaces, self.cancelled = set(), set()
        try:
            for row in json.loads(self.manifest.read_text()):
                self.sessions[ident(row['id'])] = dict(row, running=False, restored=True, buffer=bytearray(), seq=0)
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def metadata(self, s):
        return {k: s[k] for k in ('id', 'cwd', 'title', 'kind', 'running', 'exit', 'created', 'restored', 'stopped') if k in s}

    def persist(self):
        temp = self.manifest.with_suffix('.tmp')
        temp.write_text(json.dumps([self.metadata(s) for s in self.sessions.values()]))
        temp.chmod(0o600)
        os.replace(temp, self.manifest)

    def persist_lifecycle(self):
        temp = self.lifecycle.with_suffix('.tmp')
        temp.write_text(json.dumps(dict(closed=sorted(self.closed_workspaces), cancelled=sorted(self.cancelled))))
        temp.chmod(0o600)
        os.replace(temp, self.lifecycle)

    def stop(self, s):
        if not s['running']:
            return
        groups = {s['pid']}
        try:
            foreground = os.tcgetpgrp(s['fd'])
            if foreground > 0:
                groups.add(foreground)
        except OSError:
            pass
        s['stop_groups'] = groups
        s['stopped'] = True
        s['stopping'] = time.monotonic()
        for group in groups:
            try:
                os.killpg(group, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def send(self, sock, message):
        client = self.clients.get(sock)
        if not client:
            return
        encoded = json.dumps(message, separators=(',', ':')).encode() + b'\n'
        # A slow/disconnected viewer never blocks a running agent. Reattach replays
        # the bounded history, rather than allowing unbounded transport queues.
        if len(client['out']) + len(encoded) > LIMIT * 2:
            self.drop(sock)
            return
        client['out'].extend(encoded)
        self.selector.modify(sock, selectors.EVENT_READ | selectors.EVENT_WRITE, 'client')

    def broadcast(self, message, session=None):
        for sock, client in list(self.clients.items()):
            if client['watch'] and (not session or session in client['subscriptions']):
                self.send(sock, message)

    def drop(self, sock):
        self.clients.pop(sock, None)
        try:
            self.selector.unregister(sock)
        except (KeyError, ValueError):
            pass
        sock.close()

    def start(self, msg):
        key = ident(msg['id'])
        previous = self.sessions.get(key)
        if key in self.cancelled and not msg.get('restart'):
            raise ValueError('This session was stopped before it opened.')
        if previous and not (msg.get('restart') is True and not previous['running']):
            # Never restart a stopped session or run a reviewed task twice.
            return self.metadata(previous)
        # Keep the project's logical path (including a chosen symlink) so its
        # renderer identity matches the folder the user selected.
        cwd = os.path.abspath(os.path.expanduser(msg['cwd']))
        if cwd in self.closed_workspaces:
            raise ValueError('This workspace is closed. Open it before starting a session.')
        if not Path(cwd).is_dir():
            raise ValueError('The project folder is unavailable.')
        argv = msg['argv']
        if not isinstance(argv, list) or not argv or len(argv) > 100 or any(not isinstance(x, str) or '\0' in x for x in argv):
            raise ValueError('Invalid terminal command.')
        if not Path(argv[0]).is_absolute() or not os.access(argv[0], os.X_OK):
            raise ValueError('The selected shell or agent launcher is unavailable.')
        if sum(map(len, argv)) > 262144:
            raise ValueError('The terminal command is too long.')
        rows, cols = self.size(msg)
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                env = dict(os.environ, PWD=cwd, TERM='xterm-256color', COLORTERM='truecolor', TERM_PROGRAM='Tasktap')
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                os.execve(argv[0], argv, env)
            except Exception as error:
                os.write(2, ('Could not start terminal: ' + str(error) + '\r\n').encode())
                os._exit(127)
        os.set_blocking(fd, False)
        s = dict(id=key, pid=pid, fd=fd, cwd=cwd, title=str(msg.get('title', 'Terminal'))[:180],
                 kind='agent' if msg.get('kind') == 'agent' else 'shell', running=True,
                 buffer=bytearray(), input=bytearray(), seq=0, created=time.time(), rows=rows, cols=cols)
        self.sessions[key] = s
        self.selector.register(fd, selectors.EVENT_READ, ('pty', key))
        self.persist()
        self.broadcast({'event': 'session', 'session': self.metadata(s)})
        return self.metadata(s)

    @staticmethod
    def size(msg):
        return max(2, min(500, int(msg.get('rows', 24)))), max(10, min(500, int(msg.get('cols', 80))))

    def command(self, sock, msg):
        response = {'request': msg.get('request')}
        try:
            op = msg.get('op')
            if op == 'list':
                response['sessions'] = [self.metadata(s) for s in self.sessions.values()]
            elif op == 'watch':
                self.clients[sock]['watch'] = True
                response.update(event='sessions', sessions=[self.metadata(s) for s in self.sessions.values()])
            elif op in ('open-workspace', 'stop-workspace'):
                cwd = msg['cwd']
                if not isinstance(cwd, str) or not os.path.isabs(cwd):
                    raise ValueError('Select a valid workspace folder.')
                cwd = os.path.abspath(cwd)
                if op == 'open-workspace':
                    if cwd in self.closing_workspaces:
                        raise ValueError('This workspace is still stopping. Wait for it to close.')
                    self.closed_workspaces.discard(cwd)
                else:
                    # Fence the folder before stopping its PTYs. Late agent
                    # launches cannot escape a workspace close, even on restart.
                    ids = msg.get('ids', [])
                    if not isinstance(ids, list) or len(ids) > 10000:
                        raise ValueError('Select valid workspace sessions.')
                    cancelled = {ident(value) for value in ids if value not in self.sessions}
                    self.cancelled.update(cancelled)
                    self.closed_workspaces.add(cwd)
                    self.closing_workspaces.add(cwd)
                    for s in self.sessions.values():
                        if s['cwd'] == cwd:
                            self.stop(s)
                    self.persist()
                self.persist_lifecycle()
                response.update(event='workspace-opened' if op == 'open-workspace' else 'workspace-stopping', cwd=cwd)
            elif op == 'start':
                response.update(event='session', session=self.start(msg))
            else:
                key = ident(msg['id'])
                s = self.sessions.get(key)
                if op == 'stop' and not s:
                    # The close can beat an asynchronous agent/shell launch.
                    self.cancelled.add(key)
                    self.persist_lifecycle()
                    self.send(sock, dict(response, event='session-cancelled', id=key))
                    return
                if not s:
                    raise ValueError('This terminal session is not available.')
                response['id'] = key
                if op == 'attach':
                    self.clients[sock]['subscriptions'].add(key)
                    response.update(event='replay', data=base64.b64encode(s['buffer']).decode(), seq=s['seq'],
                                    truncated=bool(s.get('truncated')), session=self.metadata(s),
                                    cols=s.get('cols', 80), rows=s.get('rows', 24))
                elif op == 'detach':
                    self.clients[sock]['subscriptions'].discard(key)
                elif op == 'input':
                    if not s['running']:
                        raise ValueError('This session has ended.')
                    value = base64.b64decode(msg['data'], validate=True)
                    if len(value) > 65536 or len(s['input']) + len(value) > LIMIT:
                        raise ValueError('Too much input. Paste a smaller selection.')
                    s['input'].extend(value)
                    self.selector.modify(s['fd'], selectors.EVENT_READ | selectors.EVENT_WRITE, ('pty', key))
                elif op == 'resize':
                    if s['running']:
                        rows, cols = self.size(msg)
                        fcntl.ioctl(s['fd'], termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                        s.update(rows=rows, cols=cols)
                elif op == 'stop':
                    self.stop(s)
                    self.persist()
                    response.update(event='session-stopping')
                elif op == 'focus':
                    self.broadcast({'event': 'focus', 'id': key})
                else:
                    raise ValueError('Unknown terminal operation.')
            self.send(sock, response)
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.send(sock, dict(response, event='error', id=msg.get('id'), cwd=msg.get('cwd'), op=msg.get('op'), error=str(error)))

    def output(self, key, mask):
        s = self.sessions[key]
        if mask & selectors.EVENT_WRITE and s['input']:
            try:
                written = os.write(s['fd'], s['input'])
                del s['input'][:written]
                if not s['input']:
                    self.selector.modify(s['fd'], selectors.EVENT_READ, ('pty', key))
            except BlockingIOError:
                pass
            except OSError:
                self.close_fd(s)
                return
        if mask & selectors.EVENT_READ:
            try:
                chunk = os.read(s['fd'], 16384)
            except BlockingIOError:
                return
            except OSError:
                chunk = b''
            if not chunk:
                self.close_fd(s)
                return
            s['buffer'].extend(chunk)
            if len(s['buffer']) > LIMIT:
                # Cut at a line boundary when possible, then reset the viewer on
                # replay. Current attached viewers still receive the full stream.
                start = len(s['buffer']) - LIMIT
                boundary = s['buffer'].find(b'\n', start)
                del s['buffer'][:boundary + 1 if boundary >= 0 else start]
                s['truncated'] = True
            s['seq'] += 1
            self.broadcast({'event': 'output', 'id': key, 'seq': s['seq'],
                            'data': base64.b64encode(chunk).decode()}, key)

    def close_fd(self, s):
        fd = s.pop('fd', None)
        if fd is not None:
            self.selector.unregister(fd)
            os.close(fd)

    def run(self):
        path = ROOT / 'session.sock'
        path.unlink(missing_ok=True)
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(path));path.chmod(0o600)
        listener.listen(16);listener.setblocking(False)
        self.selector.register(listener, selectors.EVENT_READ, 'listener')
        while True:
            for key, mask in self.selector.select(.05):
                if key.data == 'listener':
                    sock, _ = listener.accept();sock.setblocking(False)
                    self.clients[sock] = dict(buffer=bytearray(), out=bytearray(), watch=False, subscriptions=set())
                    self.selector.register(sock, selectors.EVENT_READ, 'client')
                elif key.data == 'client':
                    sock = key.fileobj
                    client = self.clients.get(sock)
                    if not client:
                        continue
                    try:
                        if mask & selectors.EVENT_WRITE:
                            n = sock.send(client['out']);del client['out'][:n]
                            if not client['out']:
                                self.selector.modify(sock, selectors.EVENT_READ, 'client')
                        if mask & selectors.EVENT_READ:
                            chunk = sock.recv(65536)
                            if not chunk:
                                self.drop(sock);continue
                            client['buffer'].extend(chunk)
                            if len(client['buffer']) > LIMIT:
                                self.drop(sock);continue
                        # Drain large replays before preparing another response.
                        # Several full histories may be attached in one UI batch.
                        while sock in self.clients and b'\n' in client['buffer'] and len(client['out']) < 65536:
                            line, _, remainder = client['buffer'].partition(b'\n')
                            client['buffer'] = bytearray(remainder)
                            try:
                                msg = json.loads(line)
                                if not isinstance(msg, dict):
                                    raise ValueError('Expected a terminal request.')
                                self.command(sock, msg)
                            except ValueError as error:
                                self.send(sock, {'event': 'error', 'error': str(error)})
                    except BlockingIOError:
                        pass
                    except OSError:
                        self.drop(sock)
                else:
                    self.output(key.data[1], mask)
            for s in list(self.sessions.values()):
                if s.get('stopping') and time.monotonic() - s['stopping'] > 2:
                    for group in s.pop('stop_groups', set()):
                        try:
                            os.killpg(group, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    s.pop('stopping', None)
                if not s['running']:
                    continue
                pid, status = os.waitpid(s['pid'], os.WNOHANG)
                if pid:
                    if 'fd' in s:
                        self.output(s['id'], selectors.EVENT_READ)
                        self.close_fd(s)
                    s.update(running=False, exit=os.waitstatus_to_exitcode(status))
                    self.persist()
                    self.broadcast({'event': 'session', 'session': self.metadata(s)})
            for cwd in list(self.closing_workspaces):
                if not any(s['cwd'] == cwd and (s['running'] or s.get('stopping')) for s in self.sessions.values()):
                    self.closing_workspaces.discard(cwd)
                    self.broadcast(dict(event='workspace-closed', cwd=cwd))
            if self.clients or any(s['running'] or s.get('stopping') for s in self.sessions.values()):
                self.idle = time.monotonic()
            elif time.monotonic() - self.idle > 60:
                path.unlink(missing_ok=True)
                return


def bridge():
    with connect() as sock:
        sock.sendall(b'{"op":"watch"}\n')
        selector = selectors.DefaultSelector()
        selector.register(sock, selectors.EVENT_READ)
        selector.register(sys.stdin, selectors.EVENT_READ)
        while True:
            for key, _ in selector.select():
                if key.fileobj is sock:
                    chunk = sock.recv(65536)
                    if not chunk:
                        return
                    sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush()
                else:
                    chunk = os.read(sys.stdin.fileno(), 65536)
                    if not chunk:
                        return
                    sock.sendall(chunk)


if __name__ == '__main__':
    if sys.argv[1:] == ['serve']:
        private_root()
        with (ROOT / 'service.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                sys.exit(0)
            Service().run()
    elif sys.argv[1:] == ['bridge']:
        bridge()
