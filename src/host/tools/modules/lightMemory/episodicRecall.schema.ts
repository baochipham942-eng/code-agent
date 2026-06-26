// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const episodicRecallSchema: ToolSchema = {
  name: 'EpisodicRecall',
  description:
    'Full-text search past session messages by keyword (FTS5 trigram-backed). ' +
    'Use when the current task looks similar to something done before — search first, ' +
    'then decide if historical context applies. Returns matching message snippets with ' +
    'session id and timestamp. Scope defaults to all sessions; pass session_scope="current" ' +
    'to limit to the active session. Query must be ≥ 3 characters (trigram requirement).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keyword(s) to search (min 3 chars). Plain queries are treated as a phrase literal, ' +
          'so special characters like `-` `:` are matched literally. ' +
          'Prefix the query with `"` to use raw FTS5 syntax (AND/OR/NOT/prefix). ' +
          'Works for both Chinese and English via trigram tokenizer.',
      },
      limit: {
        type: 'number',
        description: 'Maximum snippets to return (default 5, max 10).',
      },
      session_scope: {
        type: 'string',
        enum: ['current', 'all'],
        description: '"current" to search only in the active session; "all" (default) for cross-session recall.',
      },
    },
    required: ['query'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
