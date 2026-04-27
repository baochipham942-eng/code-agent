// ============================================================================
// Send Input Tool - Send messages to running sub-agents
// Phase 3: Mid-execution communication
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import { getParallelAgentCoordinator } from '../parallelAgentCoordinator';
import { getSpawnGuard } from '../spawnGuard';

export const sendInputTool: Tool = {
  name: 'send_input',
  description: `Send a message to a running sub-agent. The message is queued and delivered at the start of the agent's next iteration.

Reuse running agents via send_input when follow-up tasks depend on their prior context, instead of spawning a new agent.`,
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const agentId = params.agentId as string;
    const message = params.message as string;

    if (!agentId || !message) {
      return { success: false, error: 'agentId and message are required' };
    }

    const guard = getSpawnGuard();
    const agent = guard.get(agentId);

    if (!agent) {
      const sentToParallelAgent = getParallelAgentCoordinator().sendMessage(agentId, message);

      if (sentToParallelAgent) {
        return {
          success: true,
          output: `Message queued for parallel agent [${agentId}]. It will be delivered at the start of the next iteration.`,
        };
      }

      return { success: false, error: `Agent not found: ${agentId}` };
    }

    if (agent.status !== 'running') {
      return {
        success: false,
        error: `Agent [${agentId}] is not running (status: ${agent.status}). Cannot send input to a finished agent.`,
      };
    }

    // Normal mode: queue the message
    const sent = guard.sendMessage(agentId, message);

    if (sent) {
      return {
        success: true,
        output: `Message queued for agent [${agentId}] (${agent.role}). It will be delivered at the start of the next iteration.`,
      };
    } else {
      return {
        success: false,
        error: `Failed to send message to agent [${agentId}]`,
      };
    }
  },
};

// PascalCase alias
export const SendInputTool: Tool = {
  ...sendInputTool,
  name: 'SendInput',
};
