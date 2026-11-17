// The workspace's one modal dialog (`#modal`), in 1.2's frame: closing a live tab, stopping a
// session, closing a workspace, opening one, finding in a terminal, moving a tab, a new task, and
// a routing question that belongs to no session.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Capture, cap } from '../capture.tsx';
import { Icon } from '../icons.tsx';
import * as L from './layout.ts';
import {
  call, dismiss, fail, finishClose, focus, focusTerminal, keepInBackground, label, layout, openWorkspace, pickFolder, projectName,
  records, setLayout, stop, ui,
} from './model.ts';
import { engines } from './terminal.ts';

function Frame({ title, over, children }: { title: string; over?: string; children: ComponentChildren }) {
  return (
    <div class="dialog-body">
      <div class="dialog-title">
        <div>{over && <span class="eyebrow">{over}</span>}<h2 id="dialog-heading">{title}</h2></div>
        <button type="button" class="icon-btn" aria-label="Close dialog" onClick={dismiss}><Icon name="x" /></button>
      </div>
      {children}
    </div>
  );
}
const Button = ({ icon, kind = 'btn', children, onClick }: { icon?: string; kind?: string; children: ComponentChildren; onClick: () => void }) => (
  <button type="button" class={kind} onClick={onClick}>{icon && <Icon name={icon} />}<span>{children}</span></button>
);

function Find({ id }: { id: string }) {
  const [said, say] = useState('');
  return (
    <Frame title="Find in terminal" over={label(id)}>
      <form class="stack" onSubmit={(e) => {
        e.preventDefault();
        const text = (e.currentTarget.querySelector('input')?.value ?? '');
        say(engines.get(id)?.search.findNext(text) ? 'Match highlighted in the terminal.' : 'No match in the available scrollback.');
      }}>
        <label class="field">Search<input id="deck-find-text" type="search" autoFocus /></label>
        <button class="primary" type="submit"><span>Find next</span></button>
        <p id="deck-find-state" role="status">{said}</p>
      </form>
    </Frame>
  );
}

function Picker() {
  const [query, setQuery] = useState('');
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const closed = [...records.projects.values()].filter((p) => !p.open && p.kind === 'folder'
    && words.every((w) => `${p.name} ${p.folder}`.toLocaleLowerCase().includes(w)));
  return (
    <Frame title="Open workspace" over="Workspaces">
      <section class="workspace-picker">
        <div class="workspace-picker-actions"><Button icon="folder" onClick={() => void pickFolder()}>Open folder…</Button></div>
        <label class="sr-only" for="workspace-picker-search">Find a workspace or folder</label>
        <input type="search" id="workspace-picker-search" placeholder="Find a workspace or folder…" autocomplete="off" value={query}
          onInput={(e) => setQuery(e.currentTarget.value)} />
        <div id="workspace-picker-results">
          {closed.length ? (
            <section class="workspace-picker-section">
              <h3>Closed workspaces</h3>
              {closed.map((p) => (
                <button type="button" class="workspace-picker-row" title={p.folder} onClick={() => void openWorkspace(p.folder)}>
                  <Icon name="folder" />
                  <span><strong>{p.name}</strong><small>{p.available ? p.folder : `Folder unavailable / ${p.folder}`}</small></span>
                  <Icon name="right" />
                </button>
              ))}
            </section>
          ) : (
            <p class="nav-external-empty">{query ? 'No workspaces match your search.' : 'Choose a folder to get started.'}</p>
          )}
        </div>
        <p class="hint">Closing a workspace stops its sessions. Reopening restores its saved layout and history without restarting processes.</p>
      </section>
    </Frame>
  );
}

function Body() {
  const d = ui.dialog;
  if (!d) return null;
  switch (d.kind) {
    case 'close-tab':
      return (
        <Frame title="Close this session?" over={label(d.id)}>
          <p>Keep it running under its workspace in the sidebar, or end the process.</p>
          <div class="stack">
            <Button icon="sessions" onClick={() => keepInBackground(d.project, d.id)}>Keep running in background</Button>
            <Button icon="stop" onClick={() => stop(d.project, d.id)}>Stop session</Button>
            <Button kind="text-btn" onClick={dismiss}>Cancel</Button>
          </div>
        </Frame>
      );
    case 'stop':
      return (
        <Frame title="Stop this session?" over={label(d.id)}>
          <p>This ends the process. Its history stays in the terminal.</p>
          <div class="form-actions">
            <Button onClick={dismiss}>Keep running</Button>
            <Button kind="primary" icon="stop" onClick={() => stop(d.project, d.id)}>Stop session</Button>
          </div>
        </Frame>
      );
    case 'close-workspace':
      return (
        <Frame title={`Close workspace and stop ${d.count} session${d.count === 1 ? '' : 's'}?`} over={projectName(d.project)}>
          <p>Running tasks and terminals will end, including background sessions. Your files, history, and saved layout remain.</p>
          <div class="form-actions">
            <Button onClick={dismiss}>Cancel</Button>
            <Button kind="primary" icon="stop" onClick={() => void finishClose(d.project, true)}>Stop sessions and close</Button>
          </div>
        </Frame>
      );
    case 'open-workspace':
      return <Picker />;
    case 'find':
      return <Find id={d.id} />;
    case 'move': {
      const l = layout(d.project);
      const from = L.paneOf(l, d.id);
      return (
        <Frame title="Move tab" over="Choose a surface">
          <div class="stack">
            {L.panes(l).map((p, i) => p === from ? null : (
              <Button icon="side" onClick={() => {
                setLayout(d.project, L.move(layout(d.project), d.id, p.id));
                dismiss();
                focusTerminal(d.id);
              }}>{`Surface ${i + 1} / ${p.active ? label(p.active) : 'Empty surface'}`}</Button>
            ))}
          </div>
        </Frame>
      );
    }
    case 'capture':
      return (
        <Frame title="New task" over={cap.dest && cap.dest !== 'idea' ? projectName(cap.dest) : undefined}>
          <Capture started={dismiss} />
        </Frame>
      );
    case 'reply': {
      const q = records.questions.get(d.question);
      if (!q || q.state !== 'open') return <Frame title="Answered"><p>This question has been answered.</p></Frame>;
      const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
      const answer = (choice: number) => void call('question.answer', { id: q.id, kind: 'choice', choice }).then(dismiss, fail);
      return (
        <Frame title={q.prompt} over={t?.text.split('\n')[0]}>
          {q.detail && <p class="hint">{q.detail}</p>}
          <div class="stack">
            {q.kind === 'choice' && q.choices.map((c, k) => <Button icon="folder" onClick={() => answer(k)}>{c}</Button>)}
          </div>
        </Frame>
      );
    }
  }
}

export function Dialogs() {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (ui.dialog && !el.open) {
      el.showModal();
      // The dialog's first choice takes the keyboard, without the ring a key press would show.
      focus(el.querySelector<HTMLElement>('[autofocus], #guide-input, .stack button, .form-actions .primary, input, .dialog-body button'));
    } else if (!ui.dialog && el.open) el.close();
  });
  return (
    <dialog id="modal" ref={ref} aria-labelledby="dialog-heading" onClose={() => ui.dialog && dismiss()}>
      <Body />
    </dialog>
  );
}
