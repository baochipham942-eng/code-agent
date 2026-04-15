// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const memoryWriteSchema: ToolSchema = {
  name: 'MemoryWrite',
  description:
    'Write, update, or delete a memory file in the persistent file-based memory system. ' +
    'Each memory is a markdown file with frontmatter (name, description, type). ' +
    'Automatically maintains INDEX.md. ' +
    'Use for saving user preferences, feedback, project context, external references, ' +
    'or reusable skills / workflows (procedural knowledge).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['write', 'delete'],
        description: '"write" creates or overwrites a memory file. "delete" removes it.',
      },
      filename: {
        type: 'string',
        description:
          'Memory filename. Must end with .md. Use "skill_<slug>.md" for skill memories ' +
          '(e.g., "skill_run_evals.md") — the "skill_" prefix enables keyword-based injection.',
      },
      name: {
        type: 'string',
        description: '[write] Memory name for frontmatter.',
      },
      description: {
        type: 'string',
        description:
          '[write] One-line description — used for relevance matching in INDEX.md and for ' +
          'keyword-based skill recall. For skill type, pack trigger keywords into this field ' +
          '(e.g., "Deploy via Tauri: bundle audio, sign, install. Keywords: tauri, deploy, dmg, release").',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference', 'skill'],
        description:
          '[write] Memory type. "skill" = reusable procedural knowledge (how to do X), ' +
          'injected into the system prompt when a new task mentions related keywords.',
      },
      content: {
        type: 'string',
        description:
          '[write] The memory content (markdown body after frontmatter). For skill type, ' +
          'structure as: ## Steps (numbered), ## Context (when to use), ## Notes (gotchas).',
      },
    },
    required: ['action', 'filename'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
