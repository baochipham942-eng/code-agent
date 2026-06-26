// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const findingsWriteSchema: ToolSchema = {
  name: 'findings_write',
  description:
    'Save important findings and research notes to findings.md. ' +
    'Use this to persist discoveries that should not be lost. ' +
    'Helps maintain knowledge across long sessions and prevents context overflow.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['code', 'architecture', 'dependency', 'issue', 'insight'],
        description:
          'Category of the finding: code (code insights), architecture (design patterns), ' +
          'dependency (library/package info), issue (problems found), insight (general observations)',
      },
      title: {
        type: 'string',
        description: 'Brief title for the finding (1-2 sentences)',
      },
      content: {
        type: 'string',
        description: 'Detailed content of the finding',
      },
      source: {
        type: 'string',
        description: 'Source file path or URL where this was discovered (optional)',
      },
    },
    required: ['category', 'title', 'content'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
