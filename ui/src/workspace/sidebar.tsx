// The sidebar of prototype/workspace-navigation.js: Home, then one heading per open workspace
// with the sessions sent to the background beneath it. A row only shows what runs; it never
// starts or resumes anything.
import { Icon } from '../icons.tsx';
import * as L from './layout.ts';
import {
  LOOSE, closeWorkspace, cue, label, layout, open, openQuestions, records, redraw, restore, show, ui, workspaces,
} from './model.ts';

/** What a workspace heading says about its sessions, most urgent first (1.2's attention). */
function attention(project: string) {
  const thoughts = [...records.thoughts.values()].filter((t) => t.project_id === project && t.mode !== 'note');
  const sessions = [...records.sessions.values()].filter((s) => s.project_id === project);
  const ids = new Set(sessions.map((s) => s.id));
  const questions = openQuestions().filter((q) => q.session_id && ids.has(q.session_id));
  const working = sessions.filter((s) => s.state === 'working' || s.state === 'starting');
  if (questions.some((q) => q.source === 'permission')) return { kind: 'permission', label: 'Needs permission', symbol: 'shield', working };
  if (questions.length) return { kind: 'input', label: 'Needs your input', symbol: 'attention', working };
  if (thoughts.some((t) => t.status === 'failed' && !t.read)) return { kind: 'failure', label: 'Needs attention', symbol: 'attention', working };
  if (thoughts.some((t) => t.status === 'done' && !t.read)) return { kind: 'complete', label: 'Result ready', symbol: 'check', working };
  if (working.length) return { kind: 'working', label: 'Working', symbol: 'sessions', working };
  return { kind: '', label: '', symbol: '', working };
}

function Workspace({ id, name, folder }: { id: string; name: string; folder?: string }) {
  const l = layout(id);
  const status = id === LOOSE ? null : attention(id);
  const current = ui.view === id;
  const folded = ui.folded.has(id);
  const detail = status?.label ?? '';
  return (
    <section class={`nav-workspace${current ? ' is-current' : ''}`} data-workspace={id} data-working={!!status?.working.length}
      data-status={status?.kind || undefined}>
      <div class="nav-workspace-heading">
        {l.background.length > 0 && (
          <button type="button" class="nav-workspace-disclosure" aria-expanded={!folded} aria-controls={`background-${id}`}
            aria-label={`${folded ? 'Expand' : 'Collapse'} background sessions for ${name}`}
            onClick={() => (folded ? ui.folded.delete(id) : ui.folded.add(id), redraw())}>
            <Icon name="right" />
          </button>
        )}
        <button type="button" class="nav-workspace-name" title={[folder, detail].filter(Boolean).join(' / ')}
          aria-label={[name, detail].filter(Boolean).join(', ')} aria-current={current ? 'page' : undefined} onClick={() => show(id)}>
          <Icon name={id === LOOSE ? 'terminal' : 'folder'} /><span>{name}</span>
        </button>
        {status?.kind && (
          <span class="nav-workspace-status" role="img" aria-label={status.label} title={status.label}><Icon name={status.symbol} /></span>
        )}
        {id !== LOOSE && (
          <button type="button" class="nav-workspace-close" aria-label={`Close ${name} workspace`} title="Close workspace and stop its sessions."
            onClick={() => closeWorkspace(id)}>
            <Icon name="x" />
          </button>
        )}
      </div>
      {l.background.length > 0 && (
        <div class="nav-background" id={`background-${id}`} hidden={folded}>
          {l.background.map((t) => {
            const c = cue(t);
            const name = label(t);
            return (
              <div class="nav-background-row" key={t}>
                <button type="button" class="nav-background-session" data-status={c.kind} title={`${name} / ${c.label}`} onClick={() => restore(id, t)}>
                  <span class="nav-background-symbol" aria-hidden="true">{c.symbol}</span>
                  <span class="nav-background-copy"><strong>{name}</strong><small>{c.label}</small></span>
                </button>
                {records.terminals.get(t)?.state === 'running' && (
                  <button type="button" class="nav-background-stop" aria-label={`Stop ${name}`} title="Stop session"
                    onClick={() => open({ kind: 'stop', project: id, id: t })}>
                    <Icon name="stop" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Sidebar() {
  const open_ = workspaces();
  const loose = L.tabs(layout(LOOSE)).length + layout(LOOSE).background.length > 0;
  return (
    <aside id="sidebar">
      <div class="brand" data-tauri-drag-region><div><strong>Tasktap</strong></div></div>
      <nav aria-label="Main navigation" id="nav">
        <div class="nav-group nav-primary">
          <button type="button" class={`nav-link${ui.view === 'home' ? ' active' : ''}`} aria-current={ui.view === 'home' ? 'page' : undefined}
            onClick={() => show('home')}>
            <Icon name="grid" /><span class="label">Home</span>
          </button>
        </div>
        <div class="nav-group nav-workspaces">
          <div class="nav-workspaces-heading">
            <span class="nav-kicker">Workspaces</span>
            <button type="button" class="nav-workspace-add" title="Open workspace" aria-label="Open workspace" onClick={() => open({ kind: 'open-workspace' })}>
              <Icon name="plus" />
            </button>
          </div>
          {open_.map((p) => <Workspace key={p.id} id={p.id} name={p.name} folder={p.folder} />)}
          {loose && <Workspace id={LOOSE} name="Sign-in terminals" />}
          {!open_.length && !loose && <span class="nav-workspace-empty">No open workspaces</span>}
        </div>
      </nav>
    </aside>
  );
}
