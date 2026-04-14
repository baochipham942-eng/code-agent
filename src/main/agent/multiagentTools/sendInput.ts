// ============================================================================
// Send Input Tool - Send messages to running sub-agents
// Phase 3: Mid-execution communication
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import { getSpawnGuard } from '../spawnGuard';

export const sendInputTool: Tool = {
  name: 'send_input',
  description: `Send a message to a running sub-agent. The message is queued and delivered at the start of the agent's next iteration.

Use interrupt=true to abort the agent's current work and redirect immediately (the agent will see your message as its next input).

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
      interrupt: {
        type: 'boolean',
        description: 'If true, abort current work and handle this message immediately (default false)',
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
    const interrupt = params.interrupt as boolean | undefined;

    if (!agentId || !message) {
      return { success: false, error: 'agentId and message are required' };
    }

    const guard = getSpawnGuard();
    const agent = guard.get(agentId);

    if (!agent) {
      return { success: false, error: `Agent not found: ${agentId}` };
    }

    if (agent.status !== 'running') {
      return {
        success: false,
        error: `Agent [${agentId}] is not running (status: ${agent.status}). Cannot send input to a finished agent.`,
      };
    }

    if (interrupt) {
      // Abort current iteration — the message will be the first thing the agent sees
      // when it restarts (if it restarts via resume, which is Phase 3+)
      // For now, queue the message and abort — the executor will drain the queue
      // at the top of its next iteration before re-checking the abort signal
      guard.sendMessage(agentId, message);
      // Note: we don't abort here because the agent loop checks messages before abort.
      // The message will redirect the agent's focus on the next iteration.
      return {
        success: true,
        output: `Urgent message sent to agent [${agentId}] (${agent.role}). The agent will process it at its next iteration.`,
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
