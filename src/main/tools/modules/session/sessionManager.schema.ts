import type { ToolSchema } from '../../../protocol/tools';

export const sessionManagerSchema: ToolSchema = {
  name: 'SessionManager',
  description: `Manage Agent Neo sessions from inside the current session without switching the active UI session.

Actions:
- list: List sessions. Supports scope="active" | "archived" | "all", query, limit, and currentWorkingDirectoryOnly.
- get: Inspect one session by ID.
- create: Create a new session without making it current. Defaults to inheriting the current session's model and working directory.
- archive: Archive another non-running session.
- unarchive: Restore an archived session.
- rename: Rename another session.

Safety:
- archive refuses the current session.
- archive refuses running, queued, paused, or cancelling sessions.
- delete is intentionally not supported.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'create', 'archive', 'unarchive', 'rename'],
        description: 'Session management action to perform',
      },
      sessionId: {
        type: 'string',
        description: '[get, archive, unarchive, rename] Target session ID',
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
        description: '[list] Maximum sessions to return. Default: 20, max: 100',
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
