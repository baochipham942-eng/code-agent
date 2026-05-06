// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const sendInputSchema: ToolSchema = {
  name: 'send_input',
  description: `Send a message to a running sub-agent. The message is queued and delivered at the start of the agent's next iteration.

Reuse running agents via send_input when follow-up tasks depend on their prior context, instead of spawning a new agent.`,
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Agent ID to send the message to',
      },
      message: {
        type: 'string',
        description: 'Message content to send',
      },
    },
    required: ['agentId', 'message'],
  },
  category: 'multiagent',
  permissionLevel: 'execute',
};
