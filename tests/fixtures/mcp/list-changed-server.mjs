// ============================================================================
// MCP listChanged 测试 fixture — stdio server，运行时动态新增工具
//
// 用途：验证 code-agent 的 MCP listChanged 通知处理（G25 Item 1）。
// 行为：
//   - 启动时暴露 ping / add_dynamic_tool 两个工具
//   - 声明 tools.listChanged capability
//   - 收到 add_dynamic_tool 调用后注册 dynamic_tool 并发 notifications/tools/list_changed
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer(
  { name: 'list-changed-fixture', version: '0.0.1' },
  { capabilities: { tools: { listChanged: true } } },
);

server.registerTool('ping', { description: 'health check' }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

let dynamicAdded = false;
server.registerTool('add_dynamic_tool', { description: 'register a new tool at runtime' }, async () => {
  if (!dynamicAdded) {
    dynamicAdded = true;
    server.registerTool('dynamic_tool', { description: 'added at runtime' }, async () => ({
      content: [{ type: 'text', text: 'dynamic result' }],
    }));
    // McpServer 在已连接状态下注册工具会自动发 listChanged；显式再发一次确保确定性
    server.sendToolListChanged();
  }
  return { content: [{ type: 'text', text: 'added' }] };
});

await server.connect(new StdioServerTransport());
