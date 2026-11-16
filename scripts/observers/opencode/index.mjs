import { emit } from '../emit.mjs';

// OpenCode 1.x plugin API. No tools, prompt transforms, or follow-up messages.
async function observer({client}) {
  let sessionId;
  let active = false;
  let lastTextAt=0;
  const roles = new Map();
  const send = event => emit({sessionId, ...event});
  return {
    event: async ({event}) => {
      const p = event.properties || {};
      if (event.type === 'session.created' && !p.info?.parentID) {
        if (!sessionId) {
          sessionId = p.info.id;
          send({kind:'session_started'});
        }
      }
      const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
      if (sid && !sessionId) sessionId = sid;
      if (sid && sid !== sessionId) return;
      if (event.type === 'session.status') {
        if (p.status?.type === 'busy' || p.status?.type === 'retry') {
          send({kind:active ? 'continued' : 'turn_started'});
          active = true;
        } else if (p.status?.type === 'idle' && active) {
          // Read the existing messages; this performs no model request.
          const response = await client.session.messages({path:{id:sessionId}});
          const messages = response.data || [];
          const last = messages.filter(m => m.info?.role === 'assistant').at(-1);
          if (last?.info?.error) send({kind:'turn_failed', error:last.info.error.name || 'Provider error'});
          else send({kind:'turn_finished', text:(last?.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n')});
          active = false;
        }
      } else if (event.type === 'message.updated') {
        roles.set(p.info.id, p.info.role);
      } else if (event.type === 'message.part.updated') {
        const part = p.part;
        if (part?.type === 'text' && part.text && roles.get(part.messageID) === 'assistant' && Date.now()-lastTextAt>500) {
          lastTextAt=Date.now();
          send({kind:'assistant_text', text:part.text});
        }
        if (part?.type === 'tool') {
          if (part.state?.status === 'running') send({kind:'activity', activity:part.tool});
          if (['completed','error'].includes(part.state?.status)) send({kind:'continued'});
        }
      } else if (event.type === 'permission.asked') send({kind:'permission_requested'});
      else if (event.type === 'question.asked') send({kind:'input_requested'});
      else if (['permission.replied','question.replied','question.rejected'].includes(event.type)) send({kind:'continued'});
      else if (event.type === 'session.error') send({kind:'turn_failed', error:p.error?.name || 'Provider error'});
    },
  };
}

export default {id:'tasktap-observer', server:observer};
