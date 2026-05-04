// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const closeAgentSchema: ToolSchema = {
  name: 'close_agent',
  description: `Close a running sub-agent. Sends an abort signal so the agent stops at the next safe point. Don't keep agents open too long if they are not needed anymore.`,
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Agent ID to close',
      },
    },
    required: ['agentId'],
  },
  category: 'multiagent',
  permissionLevel: 'execute',
};
