// ============================================================================
// List Tools Command - 列出所有可用工具
// ============================================================================

import { Command } from 'commander';

export const listToolsCommand = new Command('list-tools')
  .description('列出所有已注册的工具定义 (JSON)')
  .option('--gen <id>', '按代际过滤 (gen1-gen8)')
  .action(async (options: { gen?: string }) => {
    try {
      // 动态导入避免在顶层加载重量级模块
      const { ToolRegistry } = await import('../../main/tools/toolRegistry');
      const registry = new ToolRegistry();

      const tools = options.gen
        ? registry.getForGeneration(options.gen as import('../../shared/types').GenerationId)
        : registry.getAllTools();

      const output = tools.map(tool => {
        const params = tool.inputSchema.properties
          ? Object.entries(tool.inputSchema.properties).map(([name, prop]) => ({
              n: name,
              t: prop.type,
              required: tool.inputSchema.required?.includes(name) ?? false,
            }))
          : [];

        // 确定工具所属的最低代际作为 category
        const category = tool.generations.length > 0
          ? tool.generations.sort()[0]
          : 'unknown';

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
