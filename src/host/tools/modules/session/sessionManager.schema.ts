import type { ToolSchema } from '../../../protocol/tools';

export const sessionManagerSchema: ToolSchema = {
  name: 'SessionManager',
  description: `Manage Agent Neo sessions from inside the current session without switching the active UI session.

Actions:
- list: List sessions. Supports scope="active" | "archived" | "all", query, limit, and currentWorkingDirectoryOnly.
- get: Reference one session by ID. Sessions with at most 15 messages return their full text; longer sessions return a lazily generated cached digest.
- read: Read session messages by a 1-based inclusive range or the most recent N messages. Supports keyword filtering and a hard result limit. The result reports the total message count, selected range, returned positions, and whether more matches remain.
- create: Create a new session without making it current. Defaults to inheriting the current session's model and working directory.
- fork: Branch from a completed assistant reply into a new child session without changing or polluting the source session. Use when the user wants to explore a new direction based on a particular reply. Defaults to the current session and its latest completed assistant reply.
- archive: Archive another non-running session.
- unarchive: Restore an archived session.
- rename: Rename another session.

Safety:
- fork preserves the source session, refuses running sessions, and always shares the source session's current workspace.
- archive refuses the current session.
- archive refuses running, queued, paused, or cancelling sessions.
- delete is intentionally not supported.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'read', 'create', 'fork', 'archive', 'unarchive', 'rename'],
        description: 'Session management action to perform',
      },
      sessionId: {
        type: 'string',
        description: '[get, read, archive, unarchive, rename] Target session ID. [fork] Source session ID; omit to use the current session.',
      },
      anchorMessageId: {
        type: 'string',
        description: '[fork] Completed assistant message ID to branch from; omit to use the latest completed persisted assistant reply.',
      },
      title: {
        type: 'string',
        description: '[create, rename] Session title',
      },
      workingDirectory: {
        type: 'string',
        description: '[create] Working directory. Omit to inherit; pass an empty string to create without one.',
      },
      inheritCurrentContext: {
        type: 'boolean',
        description: '[create] Inherit model and working directory from the current session when possible. Default: true',
      },
      readOnly: {
        type: 'boolean',
        description: '[create] Mark the created session as read-only',
      },
      handoffContent: {
        type: 'string',
        description: '[create] Optional initial handoff message written into the new session',
      },
      scope: {
        type: 'string',
        enum: ['active', 'archived', 'all'],
        description: '[list] Which sessions to include. Default: active',
      },
      query: {
        type: 'string',
        description: '[list] Case-insensitive title or working directory search',
      },
      limit: {
        type: 'number',
        description: '[list] Maximum sessions to return. [read] Hard maximum messages to return. Default: 20, max: 100',
      },
      start: {
        type: 'number',
        description: '[read] 1-based inclusive start position. Omit to start at the first message. Cannot be combined with recent.',
      },
      end: {
        type: 'number',
        description: '[read] 1-based inclusive end position. Omit to end at the last message. Cannot be combined with recent.',
      },
      recent: {
        type: 'number',
        description: '[read] Select the most recent N messages. Cannot be combined with start or end.',
      },
      keyword: {
        type: 'string',
        description: '[read] Case-insensitive message-content filter applied within the selected range.',
      },
      currentWorkingDirectoryOnly: {
        type: 'boolean',
        description: '[list] Restrict results to the current working directory',
      },
      reason: {
        type: 'string',
        description: 'Short reason shown in permission prompts and audit metadata',
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: false,
  allowInPlanMode: false,
};
