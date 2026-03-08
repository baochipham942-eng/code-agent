// ============================================================================
// MCP Server Command - 启动 Code Agent 为 MCP Server
// ============================================================================
// 让其他 AI 工具通过 MCP 协议调用 Code Agent 的核心能力
//
// 使用方式:
//   code-agent mcp-server                        # stdio 模式（默认）
//   code-agent mcp-server --transport http        # HTTP 模式
//   code-agent mcp-server --enable-write-tools    # 启用写入工具
//
// 配置示例（在其他工具的 MCP 配置中）:
//   {
//     "mcpServers": {
//       "code-agent": {
//         "command": "code-agent",
//         "args": ["mcp-server"]
//       }
//     }
//   }
// ============================================================================

import { Command } from 'commander';

export const mcpServerCommand = new Command('mcp-server')
  .description('启动为 MCP Server，暴露核心工具给其他 AI 工具调用')
  .option('--transport <type>', '传输协议 (stdio|http)', 'stdio')
  .option('--port <port>', 'HTTP 端口 (仅 http 模式)', '8808')
  .option('--host <host>', 'HTTP 绑定地址 (仅 http 模式)', '127.0.0.1')
  .option('--enable-write-tools', '启用写入类工具（Edit, Write, bash 等）', false)
  .option('--working-directory <path>', '工作目录', process.cwd())
  .action(async (options: {
    transport: string;
    port: string;
    host: string;
    enableWriteTools: boolean;
    workingDirectory: string;
  }) => {
    // 动态导入避免启动时加载过多模块
    const { CodeAgentMCPServer } = await import('../../main/mcp/mcpServer.js');

    const server = new CodeAgentMCPServer({
      transport: options.transport as 'stdio' | 'http',
      port: parseInt(options.port, 10),
      host: options.host,
      enableWriteTools: options.enableWriteTools,
      workingDirectory: options.workingDirectory,
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });

    try {
      await server.start();
    } catch (error) {
      console.error('Failed to start MCP Server:', error);
      process.exit(1);
    }
  });
