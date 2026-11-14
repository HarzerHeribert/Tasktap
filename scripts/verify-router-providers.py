"""Offline fixtures for capture preparation providers and the sign-in callback."""
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import urlopen


module = SourceFileLoader('router_provider', str(Path(__file__).with_name('router-provider')))
spec = importlib.util.spec_from_loader(module.name, module)
provider = importlib.util.module_from_spec(spec)
module.exec_module(provider)

assert provider.cloud_provider({'CLAUDE_CODE_USE_BEDROCK':'true'}) == 'Amazon Bedrock'
assert not provider.cloud_provider({'CLAUDE_CODE_USE_BEDROCK':'1','CLAUDE_CODE_USE_VERTEX':'true'})
with tempfile.TemporaryDirectory() as directory:
    for route, executable in [('codex','codex'), ('cloud','claude')]:
        cli=Path(directory)/executable
        cli.write_text('''#!/usr/bin/env python3
import json,sys
from pathlib import Path
a=sys.argv[1:]
assert 'fixture capture' in sys.stdin.read()
if '--output-schema' in a:
    assert '--ignore-user-config' in a and '--ephemeral' in a
    Path(a[a.index('-o')+1]).write_text('{"brief":"ok"}')
else:
    assert '--bare' in a and a[a.index('--tools')+1]==''
    print('{"structured_output":{"brief":"ok"}}')
''')
        cli.chmod(0o700)
        with patch.dict(os.environ, {'PATH':directory+':'+os.environ['PATH'],'CLAUDE_CODE_USE_VERTEX':'1'}):
            assert provider.cli_route(dict(route=route,model='',schema={},prompt='fixture capture'))=={'brief':'ok'}

# Exercise the real loopback listener with a simulated browser. No provider contact.
def callback(argv, **_):
    q=parse_qs(urlsplit(argv[1]).query)
    assert q['client_id']==['dynamic_agent_client'] and q['code_challenge_method']==['S256']
    url=q['redirect_uri'][0]+'?'+urlencode(dict(state=q['state'][0],code='fixture',client_id='issued'))
    threading.Thread(target=lambda: urlopen(url,timeout=4).close()).start()
with patch.object(provider.subprocess,'run',side_effect=callback):
    result=provider.browser_login(dict(host='urn:uuid:test'))
assert result['client']=='issued' and result['code']=='fixture' and result['nonce'] and result['verifier']
print('Capture routing CLI arguments, cloud detection and OAuth loopback passed.')
