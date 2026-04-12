// ============================================================================
// List Tools Command - 列出所有可用工具
// ============================================================================

import { Command } from 'commander';

export const listToolsCommand = new Command('list-tools')
  .description('列出所有已注册的工具定义 (JSON)')
  .option('--gen <id>', '按代际过滤 (gen1-gen8)')
  .action(async (_options: { gen?: string }) => {
    try {
      // 动态导入避免在顶层加载重量级模块
      const { getToolResolver } = await import('../../main/tools/toolResolver');
      const { getProtocolRegistry } = await import('../../main/tools/protocolRegistry');
      // 触发 protocol registry 初始化（注册所有工具）
      getProtocolRegistry();
      const tools = getToolResolver().listDefinitions();

      const output = tools.map(tool => {
        const params = tool.inputSchema.properties
          ? Object.entries(tool.inputSchema.properties).map(([name, prop]) => ({
              n: name,
              t: prop.type,
              required: tool.inputSchema.required?.includes(name) ?? false,
            }))
          : [];

        const category = tool.tags?.[0] ?? 'unknown';

        return {
          name: tool.name,
          description: tool.description,
          category,
          params,
        };
      });

      const json = JSON.stringify(output, null, 2);
      process.stdout.write(json + '\n', () => process.exit(0));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
