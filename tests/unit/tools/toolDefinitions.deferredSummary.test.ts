// ============================================================================
// GAP-008: getDeferredToolsSummary 必须包含 MCP 工具名索引（按 server 分组）
// 验收：接入 ≥2 个 MCP server 后，系统提示词中 MCP 工具只有名字索引，schema 按需加载
// ============================================================================

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getDeferredToolsSummary } from '../../../src/main/tools/dispatch/toolDefinitions';
import {
  getToolSearchService,
  resetToolSearchService,
} from '../../../src/main/services/toolSearch/toolSearchService';

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../src/main/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [] }),
}));

vi.mock('../../../src/main/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: () => [],
}));

describe('getDeferredToolsSummary MCP name index (GAP-008)', () => {
  beforeEach(() => {
    resetToolSearchService();
  });

  it('lists builtin deferred tools and no MCP groups when no server is connected', () => {
    const summary = getDeferredToolsSummary();

    expect(summary).toContain('Browser');
    expect(summary).not.toContain('[mcp:');
  });

  it('appends MCP tool name index grouped by server (names only, no schema)', () => {
    const service = getToolSearchService();
    service.registerMCPTools([
      {
        name: 'mcp__github__search_code',
        shortDescription: 'Search code across GitHub repositories',
        tags: ['mcp', 'network'],
        aliases: ['search_code', 'github'],
        source: 'mcp',
        mcpServer: 'github',
      },
      {
        name: 'mcp__github__create_issue',
        shortDescription: 'Create a GitHub issue',
        tags: ['mcp', 'network'],
        aliases: ['create_issue', 'github'],
        source: 'mcp',
        mcpServer: 'github',
      },
      {
        name: 'mcp__supabase__execute_sql',
        shortDescription: 'Execute SQL on Supabase',
        tags: ['mcp', 'network'],
        aliases: ['execute_sql', 'supabase'],
        source: 'mcp',
        mcpServer: 'supabase',
      },
    ]);

    const summary = getDeferredToolsSummary();

    // 两个 server 各成一组
    expect(summary).toContain('[mcp:github] mcp__github__search_code | mcp__github__create_issue');
    expect(summary).toContain('[mcp:supabase] mcp__supabase__execute_sql');
    // 名字索引不携带 schema / 描述正文
    expect(summary).not.toContain('Search code across GitHub repositories');
    expect(summary).not.toContain('inputSchema');
  });

  it('drops MCP groups from the summary after the server is unregistered', () => {
    const service = getToolSearchService();
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code across GitHub repositories',
      tags: ['mcp', 'network'],
      aliases: ['search_code'],
      source: 'mcp',
      mcpServer: 'github',
    });

    expect(getDeferredToolsSummary()).toContain('[mcp:github]');

    service.unregisterMCPServer('github');

    expect(getDeferredToolsSummary()).not.toContain('[mcp:github]');
  });
});
