// Peek: one session's terminal, to watch an agent work and type into it. Deliberately bare;
// the workspace comes later. Output is granted back to the core as xterm.js has drawn it.
import '@xterm/xterm/css/xterm.css';
import './peek.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { render } from 'preact';
import { tauriBridge } from '../bridge.ts';
import { Client, Records, type Stream } from '../client.ts';

/** Bytes the core may send ahead of what the terminal has drawn. */
const WINDOW = 512 << 10;
const session = new URLSearchParams(location.search).get('session') ?? '';
const client = new Client(tauriBridge());
const records = new Records();
const encoder = new TextEncoder();
// The workspace's neutral terminal look (prototype/workspace-deck.js), over the window's backdrop.
const term = new Terminal({
  fontFamily: 'Menlo, Monaco, monospace', fontSize: 13, scrollback: 10000, allowTransparency: true, cursorBlink: false,
  theme: {
    background: '#0d111700', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#364253', black: '#21252b',
    red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef',
    brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
let stream: Stream | null = null;
let terminal: string | null = null;
let ended = '';

function Bar() {
  const s = records.sessions.get(session);
  const t = s?.thought_id ? records.thoughts.get(s.thought_id) : undefined;
  const project = s && records.projects.get(s.project_id)?.name;
  const state = ended || (s ? { starting: 'Starting', idle: 'Waiting for you', working: 'Working', ended: 'Ended' }[s.state] : 'Connecting');
  return (
    <header class="peek-bar">
      <strong>{t?.text.split('\n')[0] || s?.name || 'Session'}</strong>
      <span>{[project, s?.agent, state].filter(Boolean).join(' / ')}</span>
    </header>
  );
}

const draw = () => render(<Bar />, document.getElementById('bar')!);

async function attach() {
  const id = records.sessions.get(session)?.terminal_id;
  if (!id || terminal) return;
  terminal = id;
  fit.fit();
  stream = await client.open('terminal.open', { id, cols: term.cols, rows: term.rows, credit: WINDOW }, {
    ondata: (bytes) => term.write(bytes, () => stream?.consumed(bytes.length)),
    onmark: (mark) => {
      if (mark.exit === undefined) return;
      ended = mark.exit === null ? 'Ended' : `Exited with code ${mark.exit}`;
      draw();
    },
    onclose: draw,
  });
  term.focus();
}

document.body.innerHTML = '<div id="bar"></div><div id="term"></div>';
term.open(document.getElementById('term')!);
term.onData((data) => stream?.write(encoder.encode(data)));
term.onResize(({ cols, rows }) => {
  if (terminal) void client.call('terminal.resize', { id: terminal, cols, rows }).catch(() => {});
});
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term')!);
records.onchange = () => {
  draw();
  void attach().catch((e: Error) => ((ended = e.message), draw()));
};
draw();
void client.sub(['sessions', 'thoughts', 'projects'], records);
