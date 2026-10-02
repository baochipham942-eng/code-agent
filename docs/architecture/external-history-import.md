# External history import

`agentEngine/importHistory` maps one Claude Code or Codex CLI JSONL session to a
validated `neo.session-export` envelope. The action only prepares the envelope;
the existing session fork import route performs the eventual Neo state write.

The portable session origin carries this provenance metadata:

- `kind`: always `external_history`
- `engine`: `claude_code` or `codex_cli`
- `sourceSessionId`: external session identifier
- `sourceDigest`: SHA-256 digest of the source JSONL file
- `sourcePathDigest`: SHA-256 digest of the source path

Import loss rules are deliberately small and stable:

- Only `user` and `assistant` messages are imported.
- `tool_use` and `tool_result` blocks are dropped, including their text and
  tool-call identifiers; no dangling `tool_call` content parts are emitted.
- System and other meta messages are dropped.
- Thinking/reasoning text is retained in the message `thinking` field.
- Source timestamps are retained when present.
- Claude text blocks keep paragraph boundaries: CRLF becomes LF, text blocks
  are separated by a blank line, and only the complete visible text is trimmed.

The returned envelope is suitable for the existing `importSessionFork` path and
contains no direct session write or renderer entry point.
