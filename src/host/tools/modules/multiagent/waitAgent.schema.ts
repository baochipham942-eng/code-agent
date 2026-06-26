// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const waitAgentSchema: ToolSchema = {
  name: 'wait_agent',
  description: `Wait for one or more sub-agents to reach a final status. Only use when truly blocked on the result — prefer doing non-overlapping work while agents run.

Returns each agent's final status and result summary.`,
  inputSchema: {
    type: 'object',
    properties: {
      agentIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to wait on',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default 30000, max 600000)',
      },
    },
    required: ['agentIds'],
  },
  category: 'multiagent',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
