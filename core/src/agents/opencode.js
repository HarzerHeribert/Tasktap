// Tasktap's part in OpenCode's terminal interface. Tasktap writes this file
// before each run and names its folder in OPENCODE_CLI_CONFIG_CONTENT, for
// that run alone; a change made here is overwritten.
//
// It tells Tasktap what the session on screen does: each event that counts is
// given to `tasktap hook opencode` on standard input, as OpenCode's server
// sent it, with what the event leaves out (the tool's name, the last text
// said). For an approval or a question that program waits for the
// person's answer in Tasktap and prints it, and the answer is given to
// OpenCode here, as its own dialog would; answered in the dialog first, it
// prints nothing.
import { spawn } from "node:child_process";

const TASKTAP = "@TASKTAP@";

const HEARD = new Set([
  "session.inbox.enqueued",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.tool.called",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
]);
const ASKS = new Set(["permission.asked", "form.created"]);

// Runs the hook with one payload; resolves with what it printed.
function hook(payload) {
  return new Promise((resolve) => {
    let printed = "";
    try {
      const child = spawn(TASKTAP, ["hook", "opencode"], { stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.on("data", (chunk) => (printed += chunk));
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(printed));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      resolve("");
    }
  });
}

export default {
  id: "tasktap",
  setup(context) {
    const tools = new Map(); // a tool call's name, by the call's id
    const texts = new Map(); // what a session last said in its turn
    // The session this run is: the one on screen, or the one whose
    // sub-agent is on screen. A sub-agent is a session of its own, and what
    // it does is not reported.
    const shown = () => {
      const route = context.ui.router.current();
      if (route?.type !== "session") return undefined;
      return context.data.session.root(route.sessionID) ?? route.sessionID;
    };
    // What the hook printed, given to OpenCode as the person's answer.
    const answer = (session, data, location, printed) => {
      let reply;
      try {
        reply = JSON.parse(printed);
      } catch {
        return;
      }
      const settled = () => {};
      if (reply?.decision) {
        const request = { sessionID: session, requestID: data.id, ...reply };
        context.data.session.permission.reply(request).catch(settled);
      } else if (reply?.answer) {
        const form = { sessionID: session, formID: data.form.id, answer: reply.answer };
        context.data.session.form.reply(form, location).catch(settled);
      } else if (reply?.cancel) {
        const form = { sessionID: session, formID: data.form.id };
        context.data.session.form.cancel(form, location).catch(settled);
      }
    };
    // One hook after the other, so that the events arrive in their order; one
    // that waits for the person does not hold up the next.
    let last = hook({ type: "ready" });
    return context.data.listen(({ details }) => {
      try {
        const { id, type, data, location } = details ?? {};
        const session = data?.sessionID ?? data?.form?.sessionID;
        if (!type || !session || session !== shown()) return;
        if (type === "session.tool.input.started") tools.set(data.id, data.name);
        if (type === "session.text.ended") texts.set(session, data.text);
        if (type === "session.execution.started") texts.delete(session);
        // What a person told it; what a sub-agent brings back is no prompt.
        if (type === "session.inbox.enqueued" && data.item?.type !== "user") return;
        if (!HEARD.has(type)) return;
        const payload = { id, type, data };
        if (type === "session.tool.called") {
          payload.tool = tools.get(data.id);
          tools.delete(data.id);
        }
        if (type === "session.execution.succeeded") payload.text = texts.get(session);
        last = last.then(() => {
          const printed = hook(payload);
          if (!ASKS.has(type)) return printed;
          printed.then((said) => answer(session, data, data.form?.location ?? location, said));
        });
      } catch {}
    });
  },
};
