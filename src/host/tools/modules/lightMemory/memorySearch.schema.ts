// Schema-only file（与同目录其余记忆工具一致：单一真源）
import type { ToolSchema } from '../../../protocol/tools';

/** 可检索的记忆类型（与 MemoryRecord['type'] 对齐；新增类型时两处一起改） */
const MEMORY_SEARCH_TYPES = [
  'user_preference',
  'code_pattern',
  'project_knowledge',
  'conversation',
  'tool_usage',
  'desktop_activity',
  'workspace_activity',
  'ocr_result',
  'photo_archive',
] as const;

export const memorySearchSchema: ToolSchema = {
  name: 'memory_search',
  description:
    'Full-text search the local memory database (BM25, with LIKE fallback). '
    + 'This is the DB-backed memory store — different from MemoryRead/MemoryWrite, which read and write the file-based memory system. '
    + 'Use it to find what earlier runs wrote here: OCR text extracted from images (type="ocr_result"), '
    + 'archived photos (type="photo_archive"), and knowledge flushed from compacted context. '
    + 'Typical use: the user asks "find the screenshot that mentions X" — search here instead of scanning the filesystem.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for. Matched against memory content and summary.',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_SEARCH_TYPES],
        description: 'Optional filter, e.g. "ocr_result" for text recognized in images.',
      },
      category: {
        type: 'string',
        description: 'Optional category filter.',
      },
      limit: {
        type: 'number',
        description: 'Max records to return (default 10, max 50).',
      },
    },
    required: ['query'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
