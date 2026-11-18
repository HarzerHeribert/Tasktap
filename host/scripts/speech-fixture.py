# A speech service of the check's own, on this machine: it answers every recording with the words in a file, or fails
# for the model fixture-fail, and notes what it was sent: the path, the recording's rate, channels and bits, its
# length in seconds, its loudest sample and the pitch its zero crossings give.
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
says, log = sys.argv[1], sys.argv[2]
class Service(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        at = body.find(b'RIFF')
        num = lambda a, n: int.from_bytes(body[at + a:at + a + n], 'little')
        rate, channels, bits, size = num(24, 4), num(22, 2), num(34, 2), num(40, 4)
        s = [int.from_bytes(body[i:i + 2], 'little', signed=True) for i in range(at + 44, at + 44 + size - 1, 2)]
        crossings = sum(1 for a, b in zip(s, s[1:]) if (a < 0) != (b < 0))
        seconds = len(s) / max(1, rate)
        open(log, 'a').write(f"{self.path} {rate} {channels} {bits} {seconds:.2f} {max(map(abs, s), default=0)} {crossings / 2 / max(seconds, 0.001):.0f}\n")
        code, out = (500, {'error': {'message': 'The model is on fire'}}) if b'fixture-fail' in body else (200, {'text': open(says).read().strip()})
        out = json.dumps(out).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)
server = HTTPServer(('127.0.0.1', 0), Service)
print(server.server_address[1], flush=True)
server.serve_forever()
