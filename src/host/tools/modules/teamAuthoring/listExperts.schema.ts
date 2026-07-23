import type { ToolSchema } from '../../../protocol/tools';

export const listExpertsSchema: ToolSchema = {
  name: 'list_experts',
  description:
    'List the authoritative local expert roster that can be used to form a team. Call this before drafting a team; do not use Bash or Glob to inspect the filesystem and guess roles.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
