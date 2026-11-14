"""Bounded, public conversation excerpts for current session names; never tool output or reasoning."""
import json
from pathlib import Path


def excerpt(path):
    try:
        path = Path(path)
        if not path.is_file(): return ''
        with path.open('rb') as source:
            size = path.stat().st_size
            source.seek(max(0, size - 131072))
            if size > 131072: source.readline()
            lines = source.read(131072).splitlines()
        messages = []
        for line in lines:
            try: item = json.loads(line)
            except (ValueError, UnicodeError): continue
            text = None
            if item.get('type') == 'event_msg':
                payload = item.get('payload', {})
                if payload.get('type') in ('user_message', 'agent_message'):
                    text = payload.get('message')
            elif item.get('type') == 'response_item':
                payload = item.get('payload', {})
                if payload.get('type') == 'message' and payload.get('role') in ('user', 'assistant') and payload.get('phase') != 'analysis':
                    text = ' '.join(p.get('text', '') for p in payload.get('content', []) if isinstance(p, dict) and p.get('type') in ('input_text', 'output_text'))
            elif item.get('type') in ('user', 'assistant'):
                content = item.get('message', {}).get('content')
                if isinstance(content, str): text = content
                elif isinstance(content, list):
                    text = ' '.join(p.get('text', '') for p in content if isinstance(p, dict) and p.get('type') == 'text')
            if isinstance(text, str) and text.strip() and not text.lstrip().startswith(('<environment_context>', '<system', '<developer', '<permissions')):
                normalized = ' '.join(text.split())[:1200]
                if not messages or messages[-1] != normalized: messages.append(normalized)
        return '\n'.join(messages[-5:])[-4000:]
    except (OSError, ValueError, TypeError): return ''
