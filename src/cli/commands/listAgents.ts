// ============================================================================
// List Agents Command - 列出所有 Agent 定义（含自定义）
// ============================================================================

import { Command } from 'commander';

interface ListAgentsOptions {
  workingDir?: string;
}

export const listAgentsCommand = new Command('list-agents')
  .description('列出所有 Agent 角色定义（含 user / project 自定义，JSON 输出）')
  .option('--working-dir <path>', '指定 working directory（影响 project 级 .code-agent/agents 扫描）', process.cwd())
  .action(async (options: ListAgentsOptions) => {
    try {
      const workingDir = options.workingDir || process.cwd();

      // 初始化 registry（CLI 是独立进程，desktop 那边的初始化不会复用过来）
      const { initAgentRegistry, listAllAgents, disposeAgentRegistry } = await import(
        '../../main/agent/agentRegistry'
      );
      await initAgentRegistry(workingDir);

      const entries = listAllAgents();

      const output = entries.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        source: agent.source,
        modelTier: agent.modelTier,
        readonly: agent.readonly,
        tools: agent.tools,
      }));

      const json = JSON.stringify(output, null, 2);
      // 立刻清理 watcher，避免 CLI 进程挂着
      await disposeAgentRegistry().catch(() => undefined);
      process.stdout.write(json + '\n', () => process.exit(0));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
