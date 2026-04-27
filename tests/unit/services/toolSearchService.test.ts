import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ToolSearchService } from '../../../src/main/services/toolSearch/toolSearchService';
import { DEFERRED_TOOLS_META } from '../../../src/main/services/toolSearch/deferredTools';
import { isProtocolToolName, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';
import { toolSearchTool } from '../../../src/main/tools/search/toolSearch';
import { getToolSearchService, resetToolSearchService } from '../../../src/main/services/toolSearch';

const mcpClientMocks = vi.hoisted(() => ({
  discoverLazyServersForSearch: vi.fn(),
}));

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

vi.mock('../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => mcpClientMocks,
}));

describe('ToolSearchService loadable results', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
    mcpClientMocks.discoverLazyServersForSearch.mockReset();
    mcpClientMocks.discoverLazyServersForSearch.mockResolvedValue([]);
  });

  it('does not mark searchable builtin metadata as loaded when no protocol schema exists', async () => {
    const service = new ToolSearchService();

    const result = await service.searchTools('desktop', { maxResults: 5, includeMCP: false });

    expect(result.tools.map((tool) => tool.name)).toContain('desktop_context_now');
    const desktopContext = result.tools.find((tool) => tool.name === 'desktop_context_now');
    expect(desktopContext?.loadable).toBe(false);
    expect(desktopContext?.notCallableReason).toMatch(/no registered protocol tool/i);
    expect(result.loadedTools).not.toContain('desktop_context_now');
    expect(service.isToolLoaded('desktop_context_now')).toBe(false);
  });

  it('marks builtin deferred tools as loaded only when protocol schema exists', () => {
    const service = new ToolSearchService();

    const result = service.selectTool('Task');

    expect(result.loadedTools).toEqual(['Task']);
    expect(result.tools[0]?.loadable).toBe(true);
    expect(result.tools[0]?.notCallableReason).toBeUndefined();
    expect(service.isToolLoaded('Task')).toBe(true);
  });

  it('does not load a selected builtin search result without protocol schema', () => {
    const service = new ToolSearchService();

    const result = service.selectTool('desktop_context_now');

    expect(result.loadedTools).toEqual([]);
    expect(result.tools[0]?.loadable).toBe(false);
    expect(result.tools[0]?.notCallableReason).toMatch(/no registered protocol tool/i);
    expect(service.isToolLoaded('desktop_context_now')).toBe(false);
  });

  it('keeps all builtin search-only metadata out of loaded deferred tools', () => {
    const service = new ToolSearchService();
    const searchOnlyBuiltinNames = DEFERRED_TOOLS_META
      .filter((meta) => meta.source === 'builtin' && !isProtocolToolName(meta.name))
      .map((meta) => meta.name);

    expect(searchOnlyBuiltinNames.length).toBeGreaterThan(0);

    for (const name of searchOnlyBuiltinNames) {
      const result = service.selectTool(name);

      expect(result.loadedTools).toEqual([]);
      expect(result.tools[0]?.loadable).toBe(false);
      expect(result.tools[0]?.notCallableReason).toMatch(/no registered protocol tool/i);
      expect(service.isToolLoaded(name)).toBe(false);
    }
  });

  it('allows registered MCP tools to become loaded dynamic callables', async () => {
    const service = new ToolSearchService();
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code on GitHub',
      tags: ['mcp', 'network'],
      aliases: ['search_code', 'github'],
      source: 'mcp',
      mcpServer: 'github',
    });

    const result = await service.searchTools('search_code', { maxResults: 3 });

    expect(result.loadedTools).toEqual(['mcp__github__search_code']);
    expect(result.tools[0]?.loadable).toBe(true);
    expect(result.tools[0]?.canonicalInvocation).toBe('mcp__github__search_code');
    expect(service.isToolLoaded('mcp__github__search_code')).toBe(true);
  });

  it('exposes canonical Skill invocation without pretending the skill is a direct tool', async () => {
    const service = new ToolSearchService();
    service.registerSkill('commit', 'Prepare a git commit');

    const result = await service.searchTools('commit', { maxResults: 1, includeMCP: false });

    expect(result.loadedTools).toEqual([]);
    expect(result.tools[0]).toMatchObject({
      name: 'skill:commit',
      loadable: false,
      canonicalInvocation: 'Skill({"command":"commit"})',
    });
    expect(result.tools[0]?.notCallableReason).toMatch(/Skill tool/i);
  });

  it('formats not-callable search hits without saying every result is callable', async () => {
    const result = await toolSearchTool.execute({ query: 'desktop', max_results: 1 }, {} as any);

    expect(result.success).toBe(true);
    expect(result.output).toContain('不可直接调用');
    expect(result.output).toContain('没有新工具被加载');
    expect(result.output).not.toContain('这些工具现在可以直接使用');
  });

  it('formats virtual skill hits with their real invocation entry point', async () => {
    const service = getToolSearchService();
    service.registerSkill('commit', 'Prepare a git commit');

    const result = await toolSearchTool.execute({ query: 'commit', max_results: 1 }, {} as any);

    expect(result.success).toBe(true);
    expect(result.output).toContain('不可直接调用');
    expect(result.output).toContain('调用入口：Skill({"command":"commit"})');
  });

  it('keeps lazy MCP discovery metadata when search returns no tools', async () => {
    mcpClientMocks.discoverLazyServersForSearch.mockResolvedValue([{
      serverName: 'sequential-thinking',
      connected: false,
      toolCount: 0,
      error: 'spawn failed',
    }]);

    const result = await toolSearchTool.execute({ query: 'sequential-nohit', max_results: 1 }, {} as any);

    expect(result.success).toBe(true);
    expect(result.output).toContain('MCP 懒加载发现失败');
    expect(result.output).toContain('sequential-thinking: spawn failed');
    expect(result.metadata).toMatchObject({
      mcpDiscovery: [{
        serverName: 'sequential-thinking',
        connected: false,
        toolCount: 0,
        error: 'spawn failed',
      }],
    });
  });
});
