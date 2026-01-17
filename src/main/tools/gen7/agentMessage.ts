// ============================================================================
// Agent Message Tool - Communicate with spawned agents
// Gen 7: Multi-Agent capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { getSpawnedAgent, listSpawnedAgents } from './spawnAgent';

type MessageAction = 'status' | 'list' | 'result' | 'cancel';

export const agentMessageTool: Tool = {
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
  generations: ['gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as MessageAction;
    const agentId = params.agentId as string | undefined;

    switch (action) {
      case 'list': {
        const agents = listSpawnedAgents();
        if (agents.length === 0) {
          return {
            success: true,
            output: 'No agents have been spawned in this session.',
          };
        }

        const agentList = agents.map((a) => {
          const statusIcon = {
            idle: '⏸️',
            running: '🔄',
            completed: '✅',
            failed: '❌',
          }[a.status];

          return `${statusIcon} [${a.id}] ${a.role} - ${a.status}
   Task: ${a.task?.substring(0, 50)}${(a.task?.length || 0) > 50 ? '...' : ''}`;
        }).join('\n\n');

        return {
          success: true,
          output: `Spawned Agents (${agents.length}):\n\n${agentList}`,
        };
      }

      case 'status': {
        if (!agentId) {
          return { success: false, error: 'agentId required for status action' };
        }

        const agent = getSpawnedAgent(agentId);
        if (!agent) {
          return { success: false, error: `Agent not found: ${agentId}` };
        }

        return {
          success: true,
          output: `Agent Status:
- ID: ${agent.id}
- Role: ${agent.role}
- Status: ${agent.status}
- Task: ${agent.task}
${agent.error ? `- Error: ${agent.error}` : ''}
${agent.result ? `- Has Result: Yes (use action='result' to retrieve)` : ''}`,
        };
      }

      case 'result': {
        if (!agentId) {
          return { success: false, error: 'agentId required for result action' };
        }

        const agent = getSpawnedAgent(agentId);
        if (!agent) {
          return { success: false, error: `Agent not found: ${agentId}` };
        }

        if (agent.status === 'running') {
          return {
            success: true,
            output: `Agent [${agentId}] is still running. Check back later.`,
          };
        }

        if (agent.status === 'failed') {
          return {
            success: false,
            error: `Agent [${agentId}] failed: ${agent.error}`,
          };
        }

        return {
          success: true,
          output: `Agent [${agentId}] Result:

Task: ${agent.task}

Output:
${agent.result || '(no output)'}`,
        };
      }

      case 'cancel': {
        if (!agentId) {
          return { success: false, error: 'agentId required for cancel action' };
        }

        const agent = getSpawnedAgent(agentId);
        if (!agent) {
          return { success: false, error: `Agent not found: ${agentId}` };
        }

        if (agent.status !== 'running') {
          return {
            success: true,
            output: `Agent [${agentId}] is not running (status: ${agent.status})`,
          };
        }

        // Note: Actual cancellation would require storing the executor reference
        // For now, we just mark it as cancelled
        agent.status = 'failed';
        agent.error = 'Cancelled by user';

        return {
          success: true,
          output: `Agent [${agentId}] cancellation requested.`,
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};
