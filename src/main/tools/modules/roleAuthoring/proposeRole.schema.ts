// Schema-only file (single source of truth) — propose_role 工具
import type { ToolSchema } from '../../../protocol/tools';

export const proposeRoleSchema: ToolSchema = {
  name: 'propose_role',
  description:
    'Draft a new persistent role (subagent) from the conversation and queue it for user confirmation. ' +
    'Use ONLY inside a "建角色 / create role" conversation where the user wants to create a new role. ' +
    'You interview the user about what the role does, then call this tool with the assembled definition. ' +
    'The draft is NOT saved automatically — it surfaces a confirmation card; the user must approve it. ' +
    'If the tool returns an error (e.g. duplicate name), adjust and call again. ' +
    'Call this again with a refined definition each time the user asks to change something before confirming.',
  inputSchema: {
    type: 'object',
    properties: {
      roleId: {
        type: 'string',
        description:
          'The role name = identity. Becomes agents/<roleId>.md and roles/<roleId>/. ' +
          'Short, human-readable, may be Chinese (e.g. "产品经理"). Must not contain / \\ or path separators.',
      },
      description: {
        type: 'string',
        description: 'One-line description of what this role specializes in (shown on the role card).',
      },
      category: {
        type: 'string',
        enum: [
          'docs-office',
          'data-analysis',
          'design-creative',
          'content-marketing',
          'research',
          'automation',
          'development',
        ],
        description: 'Product category for visual grouping (optional). Pick the closest fit.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Tool whitelist for this role (tool names as registered, e.g. Read, Write, WebSearch, Bash). ' +
          'Pick the minimum set the role needs and explain each to the user. ' +
          'Omit or empty = the role inherits the default full toolset (tell the user before doing this).',
      },
      systemPrompt: {
        type: 'string',
        description:
          'The role system prompt (markdown). Describe its expertise, working principles, and output format. ' +
          'This is the body of agents/<roleId>.md after frontmatter.',
      },
    },
    required: ['roleId', 'systemPrompt'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
