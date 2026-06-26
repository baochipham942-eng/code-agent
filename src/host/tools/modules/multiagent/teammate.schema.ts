// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const teammateSchema: ToolSchema = {
  name: 'teammate',
  description: `Communicate directly with other agents in the swarm.

Use this tool to:
- Send coordination messages to other agents
- Hand off tasks to specialized agents
- Query other agents for information
- Broadcast announcements to all agents
- Check messages from other agents

Actions:
- send: Send a message to a specific agent
- coordinate: Send a coordination notice (one-way)
- handoff: Transfer a task to another agent
- query: Ask another agent a question (expects response)
- respond: Respond to a query from another agent
- broadcast: Send a message to all agents
- inbox: View incoming messages
- agents: List all registered agents
- history: View conversation history with an agent

Parameters:
- action: What to do (required)
- to: Target agent ID (required for send/coordinate/handoff/query/respond)
- message: Message content (required for send/coordinate/handoff/query/respond/broadcast)
- responseTo: Original message ID (required for respond action)
- taskId: Related task ID (optional)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'coordinate', 'handoff', 'query', 'respond', 'broadcast', 'inbox', 'agents', 'history'],
        description: 'Action to perform',
      },
      to: {
        type: 'string',
        description: 'Target agent ID',
      },
      message: {
        type: 'string',
        description: 'Message content',
      },
      responseTo: {
        type: 'string',
        description: 'Message ID to respond to',
      },
      taskId: {
        type: 'string',
        description: 'Related task ID',
      },
    },
    required: ['action'],
  },
  category: 'multiagent',
  permissionLevel: 'execute',
};
