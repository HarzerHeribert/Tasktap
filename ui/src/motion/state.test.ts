// The motion's state from the product's records: which state each situation shows, and which wins when several
// hold at once. Run by `npm run check` with Node's own test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Thought } from '../../../core/proto/protocol.ts';
import { motionState, type Seen } from './state.ts';

type T = Pick<Thought, 'status' | 'mode' | 'read' | 'updated' | 'session_id'>;
const t = (status: Thought['status'], more: Partial<T> = {}): T => ({ status, mode: 'ask', read: false, updated: 1, session_id: null, ...more });
const state = (seen: Partial<Seen>) => motionState({ thoughts: [], sessions: [], questions: 0, routing: false, voice: false, ...seen });

test('nothing going on is idle, and so is what never started or was already read', () => {
  assert.equal(state({}), 'idle');
  assert.equal(state({ thoughts: [t('captured'), t('done', { read: true }), t('failed', { read: true })] }), 'idle');
  // A note is not work, whatever its phase.
  assert.equal(state({ thoughts: [t('working', { mode: 'note' })] }), 'idle');
});

test('each situation alone shows its own state', () => {
  assert.equal(state({ voice: true }), 'listening');
  assert.equal(state({ questions: 1 }), 'needs');
  assert.equal(state({ thoughts: [t('needs_you')] }), 'needs');
  assert.equal(state({ routing: true }), 'thinking');
  assert.equal(state({ thoughts: [t('routed')] }), 'thinking');
  assert.equal(state({ thoughts: [t('working', { session_id: 's' })], sessions: [{ id: 's', state: 'starting' }] }), 'thinking');
  assert.equal(state({ thoughts: [t('working', { session_id: 's' })], sessions: [{ id: 's', state: 'working' }] }), 'working');
  // A session started by hand in a shell, with no thought, still works.
  assert.equal(state({ sessions: [{ id: 's', state: 'working' }] }), 'working');
  assert.equal(state({ thoughts: [t('done')] }), 'done');
  assert.equal(state({ thoughts: [t('failed')] }), 'failed');
});

test('the most recent unread result decides between done and failed', () => {
  assert.equal(state({ thoughts: [t('failed', { updated: 1 }), t('done', { updated: 2 })] }), 'done');
  assert.equal(state({ thoughts: [t('done', { updated: 1 }), t('failed', { updated: 2 })] }), 'failed');
  assert.equal(state({ thoughts: [t('failed', { updated: 2, read: true }), t('done', { updated: 1 })] }), 'done');
});

test('precedence: listening, needs you, thinking, working, a result, idle', () => {
  const all = { thoughts: [t('needs_you'), t('routed'), t('working'), t('done')], questions: 1, routing: true };
  assert.equal(state({ ...all, voice: true }), 'listening');
  assert.equal(state(all), 'needs');
  assert.equal(state({ thoughts: [t('routed'), t('working'), t('failed')] }), 'thinking');
  assert.equal(state({ thoughts: [t('working'), t('failed')] }), 'working');
});
