# A web server of the check's own, on this machine, for what a preview's frame is held to (host/src/frames.rs). It
# serves frame-probe.html, a page that tries everything a frame may not do, at /probe.html; a plain page at /; and
# /away, which sends whoever asks to an address that is not this machine's by the rule. It notes every request it
# gets, with the name it was asked under, in a log: the check reads there whether anything it must not see arrived.
# It prints its port, and the spelling of an address that reaches it and that the rule calls remote (`localhost.`
# with its stop, or `0.0.0.0`, which newer web views refuse by themselves), or `none` when this machine reaches it
# by neither, so that a load that got out can be told from one that was stopped. Nothing here leaves the machine.
import sys, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
log, probe = sys.argv[1], sys.argv[2]
remote = 'none'
class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        open(log, 'a').write(f"{self.headers.get('host', '')} {self.path}\n")
        path = self.path.split('?')[0]
        if path == '/away':
            self.send_response(302)
            self.send_header('location', f'http://{remote}/leak-redirect')
            self.end_headers()
            return
        if path.startswith('/leak') or path == '/self':
            body, kind = b'leaked', 'text/plain'
        elif path == '/probe.html':
            body, kind = open(probe, 'rb').read(), 'text/html; charset=utf-8'
        elif path == '/':
            body, kind = b'<!doctype html><title>Fixture</title><body style="font:16px system-ui;margin:24px"><h1>It works</h1><p>Served on this machine.</p><a id="out" href="https://example.com/elsewhere">A link to the web</a>', 'text/html; charset=utf-8'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(body)))
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(body)
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
port = server.server_address[1]
def find():
    global remote
    for name in ('localhost.', '0.0.0.0'):
        try:
            if urllib.request.urlopen(f'http://{name}:{port}/self', timeout=2).read() == b'leaked':
                remote = f'{name}:{port}'
                break
        except Exception:
            pass
    print(port, remote, flush=True)
Thread(target=find, daemon=True).start()
server.serve_forever()
