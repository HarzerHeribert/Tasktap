# Questions from an agent

The Mac app receives questions in the background and keeps keyboard focus in the foreground app. It shows the originating workspace and session when the person reviews the card. Follow-ups keep the decision pending. A final answer belongs to the same request even if several agents ask at once.

## Connecting a session

Tasktap registers the question tool automatically when it launches an agent. An external agent launcher can start the bundled **agent-tools** command as a standard MCP stdio server. Pass the actual provider, session ID, worktree and display title for that run. The example below illustrates the server entry for a Claude Code session. Use the same entry with `--agent codex` or `--agent agy` for a compatible agent client. The request channel is opt-in per integration. Existing terminal sessions need an adapter or the tool registration. Both bundled commands use Python 3.

```json
{
  "mcpServers": {
    "workspace-assistant": {
      "command": "/Applications/Tasktap.app/Contents/Resources/agent-tools",
      "args": ["--agent", "claude", "--session", "lighting-pass-42", "--workspace", "/path/to/projects/glasshouse", "--task", "Lighting pass"]
    }
  }
}
```

The agent calls **ask_user** when it actually needs input. It supplies a stable request ID, the question, optional context and optional choices. Omitting choices yields Yes, No and Talk it through. A discussion returns the user's words and a cursor. The agent can address the follow-up, then wait again using the same request and the returned cursor. An `answer` result is the final decision. This integration forwards prompts that use the tool. Antigravity can also forward its supported one-time ACP permission choices. Claude Code and Codex retain their own permission policies.

## Scripted adapters

An adapter with its own tool loop can run the bundled **ask-user** command instead. It emits newline-delimited JSON on stdout for each follow-up and the final answer. An interrupted consumer can call it again with the same arguments and the last consumed `--after` cursor. Duplicate delivery returns the original answer. Reusing the same request ID with different text is rejected.

```sh
scripts/ask-user --agent claude --session lighting-pass-42 --request material-3 \
  --workspace ~/projects/glasshouse --task 'Lighting pass' \
  --question 'Keep the brighter rim light?' --detail 'It helps the silhouette but adds a reflection.'
```

The Mac app and adapter exchange owner-private files under `~/Library/Application Support/Tasktap/Agent Inbox`. An agent may submit before the app opens. Reading the queue on launch recovers pending questions. No network service is required. A browser preview uses its local sample state and has no access to the native inbox.
