// ============================================================================
// Close Agent Tool - Cancel/shutdown a running sub-agent
// Phase 2: Agent lifecycle control
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getSpawnGuard } from '../../agent/spawnGuard';

export const closeAgentTool: Tool = {
  name: 'close_agent',
  description: `Close a running sub-agent. Sends an abort signal so the agent stops at the next safe point. Don't keep agents open too long if they are not needed anymore.`,
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const agentId = params.agentId as string;

    if (!agentId) {
      return { success: false, error: 'agentId is required' };
    }

    const guard = getSpawnGuard();
    const agent = guard.get(agentId);

    if (!agent) {
      return { success: false, error: `Agent not found: ${agentId}` };
    }

    if (agent.status !== 'running') {
      return {
        success: true,
        output: `Agent [${agentId}] is already ${agent.status}. No action needed.`,
      };
    }

    const cancelled = guard.cancel(agentId);

    if (cancelled) {
      return {
        success: true,
        output: `Agent [${agentId}] (${agent.role}) cancelled. Running agents: ${guard.getRunningCount()}`,
      };
    } else {
      return {
        success: false,
        error: `Failed to cancel agent [${agentId}]`,
      };
    }
  },
};

// PascalCase alias
export const CloseAgentTool: Tool = {
  ...closeAgentTool,
  name: 'CloseAgent',
};
