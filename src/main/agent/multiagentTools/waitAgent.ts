// ============================================================================
// Wait Agent Tool - Wait for sub-agents to complete
// Phase 2: Agent lifecycle control
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import { getSpawnGuard } from '../spawnGuard';

export const waitAgentTool: Tool = {
  name: 'wait_agent',
  description: `Wait for one or more sub-agents to reach a final status. Only use when truly blocked on the result — prefer doing non-overlapping work while agents run.

Returns each agent's final status and result summary.`,
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const agentIds = params.agentIds as string[];
    const timeoutMs = Math.min(
      (params.timeoutMs as number) || 30_000,
      600_000 // 10 minutes max
    );

    if (!agentIds || agentIds.length === 0) {
      return { success: false, error: 'agentIds is required and must not be empty' };
    }

    const guard = getSpawnGuard();

    // Validate all IDs exist
    const missing = agentIds.filter(id => !guard.get(id));
    if (missing.length > 0) {
      return { success: false, error: `Unknown agent(s): ${missing.join(', ')}` };
    }

    // Wait
    const results = await guard.waitFor(agentIds, timeoutMs);

    // Format output
    const lines: string[] = [];
    let allDone = true;

    for (const id of agentIds) {
      const agent = results.get(id);
      if (!agent) {
        lines.push(`[${id}] NOT FOUND`);
        continue;
      }

      const icon = {
        running: '⏳',
        completed: '✅',
        failed: '❌',
        cancelled: '🚫',
      }[agent.status];

      const duration = agent.completedAt
        ? `${agent.completedAt - agent.createdAt}ms`
        : 'still running';

      lines.push(`${icon} [${id}] ${agent.role} — ${agent.status} (${duration})`);

      if (agent.status === 'running') {
        allDone = false;
        lines.push(`   Still in progress after ${timeoutMs}ms timeout`);
      } else if (agent.result) {
        // Truncate result to 1200 chars like Cline
        const output = agent.result.output.slice(0, 1200);
        lines.push(`   Result: ${output}${agent.result.output.length > 1200 ? '...' : ''}`);
        if (agent.result.iterations) {
          lines.push(`   Stats: ${agent.result.iterations} iterations, ${agent.result.toolsUsed.length} tools${agent.result.cost !== undefined ? `, $${agent.result.cost.toFixed(4)}` : ''}`);
        }
      } else if (agent.error) {
        lines.push(`   Error: ${agent.error}`);
      }
    }

    return {
      success: true,
      output: `Wait results (${allDone ? 'all done' : 'timeout — some still running'}):\n\n${lines.join('\n')}`,
    };
  },
};

// PascalCase alias
export const WaitAgentTool: Tool = {
  ...waitAgentTool,
  name: 'WaitAgent',
};
