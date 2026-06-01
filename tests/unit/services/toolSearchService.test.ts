import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ToolSearchService } from '../../../src/main/services/toolSearch/toolSearchService';
import { DEFERRED_TOOLS_META } from '../../../src/main/services/toolSearch/deferredTools';
import { getProtocolRegistry, isProtocolToolName, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';
import { resetToolSearchService } from '../../../src/main/services/toolSearch';
import type { ToolModule, ToolSchema } from '../../../src/main/protocol/tools';

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

function registerProtocolToolForSearch(name: 'Browser' | 'Computer'): void {
  const schema: ToolSchema = {
    name,
    description: `${name} test schema`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    category: 'vision',
    permissionLevel: 'execute',
    readOnly: false,
  };
  const module: ToolModule = {
    schema,
    createHandler: () => ({
      schema,
      async execute() {
        return { ok: true, output: null };
      },
    }),
  };
  getProtocolRegistry().register(schema, async () => module);
}

describe('ToolSearchService loadable results', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    registerProtocolToolForSearch('Browser');
    registerProtocolToolForSearch('Computer');
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

  it('does not add core tools to the deferred loaded set during keyword search', async () => {
    const service = new ToolSearchService();

    const result = await service.searchTools('TaskManager', { maxResults: 3, includeMCP: false });

    expect(result.tools.map((tool) => tool.name)).toContain('TaskManager');
    expect(result.loadedTools).not.toContain('TaskManager');
    expect(service.getLoadedDeferredTools()).not.toContain('TaskManager');
    expect(service.isToolLoaded('TaskManager')).toBe(true);
  });

  it('loads SessionManager as a deferred builtin callable', () => {
    const service = new ToolSearchService();

    const result = service.selectTool('session_manager');

    expect(result.loadedTools).toEqual(['SessionManager']);
    expect(result.tools[0]?.loadable).toBe(true);
    expect(result.tools[0]?.canonicalInvocation).toBe('SessionManager');
    expect(service.isToolLoaded('SessionManager')).toBe(true);
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

  it('keeps dynamic workflow and legacy workflow_orchestrate as separate invocations', async () => {
    const service = new ToolSearchService();

    const waitResult = service.selectTool('WaitAgent');
    const dynamicWorkflowResult = service.selectTool('workflow');
    const dynamicWorkflowAliasResult = service.selectTool('DynamicWorkflow');
    const workflowResult = service.selectTool('WorkflowOrchestrate');
    const searchResult = await service.searchTools('workflow', { maxResults: 2, includeMCP: false });

    expect(waitResult.loadedTools).toEqual(['wait_agent']);
    expect(waitResult.tools[0]?.canonicalInvocation).toBe('wait_agent');
    expect(service.isToolLoaded('wait_agent')).toBe(true);

    expect(dynamicWorkflowResult.loadedTools).toEqual(['workflow']);
    expect(dynamicWorkflowResult.tools[0]?.canonicalInvocation).toBe('workflow');
    expect(dynamicWorkflowAliasResult.loadedTools).toEqual(['workflow']);
    expect(dynamicWorkflowAliasResult.tools[0]?.canonicalInvocation).toBe('workflow');
    expect(searchResult.tools[0]?.name).toBe('workflow');
    expect(searchResult.tools[0]?.canonicalInvocation).toBe('workflow');

    expect(workflowResult.loadedTools).toEqual(['workflow_orchestrate']);
    expect(workflowResult.tools[0]?.canonicalInvocation).toBe('workflow_orchestrate');
    expect(service.isToolLoaded('workflow_orchestrate')).toBe(true);
  });

  it('normalizes browser/computer/screenshot compatibility aliases to unified tools', () => {
    const service = new ToolSearchService();

    const browserResult = service.selectTool('browser_action');
    const computerResult = service.selectTool('computer_use');
    const screenshotResult = service.selectTool('screenshot');

    expect(browserResult.loadedTools).toEqual(['Browser']);
    expect(browserResult.tools[0]?.canonicalInvocation).toBe('Browser');
    expect(service.isToolLoaded('Browser')).toBe(true);

    expect(computerResult.loadedTools).toEqual(['Computer']);
    expect(computerResult.tools[0]?.canonicalInvocation).toBe('Computer');
    expect(service.isToolLoaded('Computer')).toBe(true);

    expect(screenshotResult.loadedTools).toEqual(['Computer']);
    expect(screenshotResult.tools[0]?.canonicalInvocation).toBe('Computer');
  });

  it('ranks Computer first for generic screenshot searches', async () => {
    const service = new ToolSearchService();

    const result = await service.searchTools('screenshot', { maxResults: 3, includeMCP: false });

    expect(result.tools[0]?.name).toBe('Computer');
    expect(result.loadedTools).toContain('Computer');
  });

  it('explains desktop context metadata as workbench context instead of callable tools', () => {
    const service = new ToolSearchService();

    const result = service.selectTool('desktop_context_now');

    expect(result.loadedTools).toEqual([]);
    expect(result.tools[0]?.loadable).toBe(false);
    expect(result.tools[0]?.notCallableReason).toContain('Desktop workbench');
    expect(result.tools[0]?.notCallableReason).toContain('Computer');
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

  // 注：legacy toolSearchTool.execute 的输出格式化测试已迁移到
  // tests/unit/tools/modules/search/toolSearch.test.ts（native 形态：ok/output/meta）。
});
