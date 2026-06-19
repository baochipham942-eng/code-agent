// Schema-only file —— collect_agent（Kimi 借鉴 #2 / ADR-025 A1）
import type { ToolSchema } from '../../../protocol/tools';

export const collectAgentSchema: ToolSchema = {
  name: 'collect_agent',
  description: `Collect the status and result of a background sub-agent previously started via spawn_agent with run_in_background=true. By default waits for it to finish; pass wait=false to poll the current status without blocking.`,
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The background agent_id returned by spawn_agent (e.g. subagent-bg-1)',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for completion before returning (default true). false = poll current status.',
      },
    },
    required: ['agentId'],
  },
  category: 'multiagent',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
