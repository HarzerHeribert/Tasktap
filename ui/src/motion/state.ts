// Which of the motion's seven states the product is in, from the records a page already holds. One rule, first
// match wins:
//   listening  a voice source is open: the form answers the person speaking before anything else
//   needs      a question is open: nothing goes on until the person answers
//   thinking   a capture is on its way to the core (`routing`), or a launch is pending: a thought routed and held,
//              or working with its session still starting
//   working    an agent is at work
//   done or failed, by the most recent result the person has not read
//   idle       otherwise (a captured thought that never started, an idea or one undone, is not work)
import type { Session, Thought } from '../../../core/proto/protocol.ts';

export const STATES = ['idle', 'listening', 'thinking', 'working', 'needs', 'done', 'failed'] as const;
export type MotionState = (typeof STATES)[number];

export type Seen = {
  thoughts: Iterable<Pick<Thought, 'status' | 'mode' | 'read' | 'updated' | 'session_id'>>;
  sessions: Iterable<Pick<Session, 'id' | 'state'>>;
  questions: number;
  routing: boolean;
  voice: boolean;
};

export function motionState({ thoughts, sessions, questions, routing, voice }: Seen): MotionState {
  if (voice) return 'listening';
  const all = [...thoughts].filter((t) => t.mode !== 'note');
  if (questions > 0 || all.some((t) => t.status === 'needs_you')) return 'needs';
  const live = [...sessions];
  const starting = new Set(live.filter((s) => s.state === 'starting').map((s) => s.id));
  if (routing || all.some((t) => t.status === 'routed' || (t.status === 'working' && !!t.session_id && starting.has(t.session_id))))
    return 'thinking';
  if (all.some((t) => t.status === 'working') || live.some((s) => s.state === 'working')) return 'working';
  const last = all.filter((t) => (t.status === 'done' || t.status === 'failed') && !t.read).sort((a, b) => b.updated - a.updated)[0];
  return last ? (last.status as 'done' | 'failed') : 'idle';
}
