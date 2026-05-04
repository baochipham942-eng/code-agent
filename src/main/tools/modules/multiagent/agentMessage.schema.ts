// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const agentMessageSchema: ToolSchema = {
  name: 'agent_message',
  description: `Communicate with and manage spawned agents.

Use this tool to:
- Check agent status
- Get agent results
- List all spawned agents
- Cancel running agents

Parameters:
- action: What to do (status, list, result, cancel)
- agentId: Target agent ID (required for status, result, cancel)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'list', 'result', 'cancel'],
        description: 'Action to perform',
      },
      agentId: {
        type: 'string',
        description: 'Agent ID to interact with',
      },
    },
    required: ['action'],
  },
  category: 'multiagent',
  permissionLevel: 'execute',
};
