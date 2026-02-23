// ============================================================================
// List Agents Command - 列出所有核心 Agent 定义
// ============================================================================

import { Command } from 'commander';

export const listAgentsCommand = new Command('list-agents')
  .description('列出所有核心 Agent 角色定义 (JSON)')
  .action(async () => {
    try {
      const { CORE_AGENTS } = await import('../../main/agent/hybrid/coreAgents');

      const output = Object.values(CORE_AGENTS).map(agent => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        modelTier: agent.model,
        readonly: agent.readonly,
        tools: agent.tools,
      }));

      const json = JSON.stringify(output, null, 2);
      process.stdout.write(json + '\n', () => process.exit(0));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
