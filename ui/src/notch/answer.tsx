// The answer card: one card for every question, choices on 1, 2, 3, affirm and deny from any
// app, a reply in the person's own words, and "1 of N" with previous and next.
import type { AnswerQuestion, Question } from '../../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import { Icon } from '../icons.tsx';
import { agentName, call, fail, projectName, records, redraw, title, ui } from './model.ts';
import { fold, peek } from './panel.ts';

type Response = AnswerQuestion extends infer A ? (A extends { id: string } ? Omit<A, 'id'> : never) : never;

export function Answer({ questions }: { questions: Question[] }) {
  const n = questions.length;
  const i = Math.max(0, questions.findIndex((q) => q.id === (ui.question ?? records.glance?.question)));
  const q = questions[i]!;
  const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  // Affirm and deny, from any app, act on the question shown here.
  useEffect(() => {
    if (records.glance?.question !== q.id) void call('question.focus', { id: q.id }).catch(fail);
  }, [q.id]);

  const answer = (response: Response) => void call('question.answer', { id: q.id, ...response } as AnswerQuestion).catch(fail);
  const go = (step: number) => {
    ui.question = questions[(i + step + n) % n]!.id;
    Object.assign(ui, { replying: false, focus: '#notch .decision-btn, #notch #comment' });
    redraw();
  };
  const reply = () => {
    Object.assign(ui, { replying: true, focus: '#comment' });
    redraw();
  };
  const terminal = q.reply_via === 'terminal';
  const choices = terminal ? [] : q.kind === 'choice' ? q.choices : q.kind === 'confirm' ? ['Yes', 'No'] : [];
  const choose = (k: number) =>
    terminal ? s && peek(s.id) : q.kind === 'confirm' ? answer({ kind: k === 0 ? 'affirm' : 'deny' }) : answer({ kind: 'choice', choice: k });

  const keys = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement).matches('textarea, input');
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const digit = Number(k) - 1;
    if (digit >= 0 && digit < Math.max(choices.length, terminal ? 1 : 0)) choose(digit);
    else if (q.kind === 'confirm' && !terminal && (k === 'y' || k === 'n')) choose(k === 'y' ? 0 : 1);
    else if (k === 't' && !terminal) reply();
    else if ((k === 'arrowright' || k === 'arrowleft') && n > 1) go(k === 'arrowright' ? 1 : -1);
    else if (k === 'arrowdown' || k === 'arrowup') {
      const items = [...document.querySelectorAll<HTMLElement>('#notch .decision-btn, #notch #comment')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (k === 'arrowdown' ? 1 : -1) + items.length) % items.length]?.focus({ focusVisible: true });
    } else return;
    e.preventDefault();
  };

  return (
    <div class="dialog-body notch-content decision-sheet" onKeyDown={keys}>
      <div class="dialog-title">
        <div>
          <div class="decision-context">
            <span><Icon name="folder" /><span>{projectName(t?.project_id ?? s?.project_id)}</span></span>
            <span><Icon name={s?.agent ?? t?.agent ?? 'terminal'} /><span>{agentName(s?.agent ?? t?.agent)}</span></span>
            {n > 1 && <span>{i + 1} of {n}</span>}
          </div>
          <h2>{title(t) || s?.name || 'A question'}</h2>
        </div>
        <button type="button" class="icon-btn" aria-label="Close" onClick={fold}><Icon name="x" /></button>
      </div>
      <div class="stack decision-body">
        {n > 1 && <p class="decision-count">Question {i + 1} of {n}</p>}
        <h3>{q.prompt}</h3>
        {q.detail && <p class="hint">{q.detail}</p>}
        {terminal ? (
          <div class="decision-choices">
            <button type="button" class="decision-btn" onClick={() => choose(0)}>
              <kbd>1</kbd> Answer in its terminal <Icon name="terminal" />
            </button>
          </div>
        ) : q.kind === 'confirm' ? (
          <div class="binary-choices">
            <button type="button" class="decision-btn answer-yes" onClick={() => choose(0)}><Icon name="check" /><kbd>1</kbd> Yes <kbd>⌃⌥Y</kbd></button>
            <button type="button" class="decision-btn answer-no" onClick={() => choose(1)}><Icon name="x" /><kbd>2</kbd> No <kbd>⌃⌥N</kbd></button>
          </div>
        ) : (
          choices.length > 0 && (
            <div class="decision-choices">
              {choices.map((c, k) => (
                <button type="button" class="decision-btn" onClick={() => choose(k)}>{k < 9 && <kbd>{k + 1}</kbd>} {c}</button>
              ))}
            </div>
          )
        )}
        {!terminal && (q.kind === 'text' || ui.replying ? (
          <form id="discussion" class="stack" onSubmit={(e) => {
            e.preventDefault();
            const text = (e.currentTarget.querySelector('textarea')?.value ?? '').trim();
            if (text) answer({ kind: 'text', text });
          }}>
            <label class="field" for="comment">Reply
              <textarea id="comment" rows={3} placeholder="Answer in your own words…" onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }} />
            </label>
            <div class="reply-actions">
              <button class="btn primary">Send reply <Icon name="arrow" /></button>
              {q.kind !== 'text' && <button type="button" class="text-btn" onClick={() => go(0)}>Back to question</button>}
            </div>
          </form>
        ) : (
          <div class="decision-reply">
            <button type="button" class="text-btn discussion-link" onClick={reply}>Reply <kbd>T</kbd></button>
            <span>Type in your own words</span>
          </div>
        ))}
        {n > 1 && (
          <div class="reply-actions">
            <button type="button" class="text-btn" onClick={() => go(-1)}><Icon name="back" /> Previous</button>
            <button type="button" class="text-btn" onClick={() => go(1)}>Next <Icon name="arrow" /></button>
          </div>
        )}
      </div>
    </div>
  );
}
