// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const exploreSchema: ToolSchema = {
  name: 'Explore',
  description: `Launch an explorer sub-agent to gather codebase context.

Use this tool for broad, read-only codebase exploration when the target files or
functions are not yet clear. If the target file and edit region are already
known, use direct read/search/edit tools instead.

The explorer can perform multiple searches and file reads, then return a short
summary with relevant paths and line references.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task description for the subagent',
      },
      subagent_type: {
        type: 'string',
        description: 'Optional legacy subagent type. Defaults to explore.',
        enum: ['explore', 'bash', 'plan', 'code-review'],
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the agent in background (default: false)',
      },
    },
    required: ['prompt'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
