import { emit } from './emit.mjs';

export default function observer(pi) {
  let sessionId;
  const identity = ctx => ({sessionId: ctx.sessionManager.getSessionId()});
  pi.on('session_start', async (_event, ctx) => {
    sessionId = identity(ctx).sessionId;
    emit({kind:'session_started', sessionId});
  });
  pi.on('before_agent_start', async (_event, ctx) => emit({kind:'turn_started', ...identity(ctx)}));
  pi.on('agent_start', async (_event, ctx) => emit({kind:'continued', ...identity(ctx)}));
  pi.on('tool_execution_start', async event => emit({kind:'activity', sessionId, activity:event.toolName}));
  pi.on('tool_execution_end', async () => emit({kind:'continued', sessionId}));
  pi.on('message_end', async event => {
    if (event.message?.role !== 'assistant') return;
    const text = (event.message.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (text) emit({kind:'assistant_text', sessionId, text});
  });
  // agent_end is too early: automatic retries/compaction may follow it.
  pi.on('agent_settled', async (event, ctx) => {
    const entries = event.entries || ctx.sessionManager.getBranch();
    const messages = entries.map(e => e.message || e).filter(m => m.role === 'assistant');
    const last = messages.at(-1);
    if (event.aborted || last?.stopReason === 'error' || last?.stopReason === 'aborted') {
      emit({kind:last?.stopReason === 'error' ? 'turn_failed' : 'turn_interrupted', sessionId});
    } else {
      emit({kind:'turn_finished', sessionId,
        text:(last?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')});
    }
  });
  pi.on('ui_prompt_start', async () => emit({kind:'input_requested', sessionId}));
  pi.on('ui_prompt_end', async () => emit({kind:'continued', sessionId}));
  pi.on('session_shutdown', async () => emit({kind:'process_exited', sessionId}));
}
