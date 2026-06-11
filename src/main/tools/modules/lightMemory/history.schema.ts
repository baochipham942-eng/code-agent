// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { TRANSCRIPT_KINDS } from '../../../../shared/transcriptFts.sql';

export const historySchema: ToolSchema = {
  name: 'History',
  description:
    'Search the RAW conversation trajectory of past sessions: prior user/assistant messages, ' +
    'reasoning, tool inputs and tool outputs (including errors). ' +
    'Memory tools (MemoryRead) hold curated knowledge — try them first; History is the verbatim ' +
    'firehose for when curated memory has no answer, e.g. "how did we fix this error last time" ' +
    'or "did I already try X". ' +
    'Two actions: ' +
    'search — FTS5 BM25 over the transcript, filterable by kind (user_text/assistant_text/' +
    'reasoning/tool_input/tool_output), tool_name and time range; returns snippets with message ids. ' +
    'around — given a message id from a search hit, pull the ±N surrounding messages for full context. ' +
    'Typical flow: search → pick a hit → around(message_id). Query must be ≥ 3 characters ' +
    '(trigram). Plain queries match literally; prefix with `"` for raw FTS5 syntax. ' +
    'Note: system-role messages are not indexed.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'around'],
        description: 'search: full-text search the transcript; around: pull context around a message',
      },
      // --- search params ---
      query: {
        type: 'string',
        description: '[search] Keyword(s), min 3 chars. Chinese and English both supported (trigram).',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...TRANSCRIPT_KINDS] },
        description: '[search] Restrict to these transcript kinds (default: all kinds).',
      },
      tool_name: {
        type: 'string',
        description: '[search] Only match tool_input/tool_output rows of this tool (e.g. "Bash", "Read").',
      },
      time_after: {
        type: 'number',
        description: '[search] Unix ms — only messages at or after this time.',
      },
      time_before: {
        type: 'number',
        description: '[search] Unix ms — only messages at or before this time.',
      },
      session_scope: {
        type: 'string',
        enum: ['current', 'all'],
        description: '[search] "current" limits to the active session; "all" (default) searches every session.',
      },
      limit: {
        type: 'number',
        description: '[search] Max hits to return (default 10, max 50).',
      },
      // --- around params ---
      message_id: {
        type: 'string',
        description: '[around] Anchor message id (take it from a search hit).',
      },
      before: {
        type: 'number',
        description: '[around] Messages before the anchor (default 5, max 20).',
      },
      after: {
        type: 'number',
        description: '[around] Messages after the anchor (default 5, max 20).',
      },
    },
    required: ['action'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
