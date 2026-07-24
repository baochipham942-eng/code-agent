// Schema-only file（与同目录其余记忆工具一致：单一真源）
import type { ToolSchema } from '../../../protocol/tools';

export const memoryAmendSchema: ToolSchema = {
  name: 'memory_amend',
  description:
    'Correct or forget a record in the DB-backed memory store (the same store searched by memory_search — '
    + 'different from MemoryRead/MemoryWrite, which manage the file-based memory system). '
    + 'Use when the user says a stored memory is wrong, outdated, or should be forgotten. '
    + 'Target it by the "[#<id>]" handle shown next to entries in the Stored Memories / Packed Memories '
    + 'context blocks, or by an id returned from memory_search. '
    + '"update" replaces the content (and re-derives its summary); "forget" deletes the record outright.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The memory record id, e.g. from a "[#mem_...]" handle or a memory_search result.',
      },
      action: {
        type: 'string',
        enum: ['update', 'forget'],
        description: '"update" corrects the content of the record. "forget" deletes it.',
      },
      content: {
        type: 'string',
        description: '[update] The corrected content. Required when action is "update".',
      },
    },
    required: ['id', 'action'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
