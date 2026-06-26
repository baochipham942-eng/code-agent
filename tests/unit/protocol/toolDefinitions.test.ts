import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
  getDesignCanvasToolDefinitions,
  withDesignCanvasTools,
  withoutGenericMediaToolsInDesign,
} from '../../../src/host/tools/dispatch/toolDefinitions';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';
import {
  findToolSearchExecutionContractFailures,
  resolveToolSearchExecutionContract,
} from '../../../src/host/tools/dispatch/toolSearchExecutionContract';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ToolSearchItem } from '../../../src/shared/contract/toolSearch';

const mcpToolDefinition = {
  name: 'mcp__github__search_code',
  description: '[MCP:github] Search code',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  requiresPermission: true,
  permissionLevel: 'network' as const,
};

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [mcpToolDefinition],
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
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

describe('toolDefinitions deferred loading', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
  });

  it('includes loaded protocol tools and loaded MCP dynamic definitions', () => {
    const service = getToolSearchService();
    service.selectTool('Task');
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code on GitHub',
      tags: ['mcp', 'network'],
      aliases: ['search_code'],
      source: 'mcp',
      mcpServer: 'github',
    });
    service.selectTool('mcp__github__search_code');

    const definitions = getLoadedDeferredToolDefinitions();
    const names = definitions.map((definition) => definition.name);

    expect(names).toContain('Task');
    expect(names).toContain('mcp__github__search_code');
    expect(definitions.find((definition) => definition.name === 'mcp__github__search_code')).toEqual(mcpToolDefinition);
  });

  it('exposes Append as a core file tool', () => {
    const names = getCoreToolDefinitions().map((definition) => definition.name);
    expect(names).toContain('Write');
    expect(names).toContain('Append');
  });

  it('keeps core tools out of loaded deferred definitions after ToolSearch hits', async () => {
    const service = getToolSearchService();
    await service.searchTools('TaskManager', { maxResults: 3, includeMCP: false });

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('TaskManager');
  });

  it('includes canonical multiagent tools loaded through aliases without mixing workflow generations', () => {
    const service = getToolSearchService();
    service.selectTool('WaitAgent');
    service.selectTool('DynamicWorkflow');
    service.selectTool('WorkflowOrchestrate');

    const names = getLoadedDeferredToolDefinitions().map((definition) => definition.name);

    expect(names).toContain('wait_agent');
    expect(names).toContain('workflow');
    expect(names).toContain('workflow_orchestrate');
  });

  it('does not include selected searchable-only deferred metadata', () => {
    const service = getToolSearchService();
    service.selectTool('desktop_context_now');

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('desktop_context_now');
  });

  it('keeps ToolSearch loadable results aligned with executable definitions', () => {
    const service = getToolSearchService();
    const taskResult = service.selectTool('Task');
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code on GitHub',
      tags: ['mcp', 'network'],
      aliases: ['search_code'],
      source: 'mcp',
      mcpServer: 'github',
    });
    const mcpResult = service.selectTool('mcp__github__search_code');
    const desktopResult = service.selectTool('desktop_context_now');

    const items = [
      ...taskResult.tools,
      ...mcpResult.tools,
      ...desktopResult.tools,
    ];

    expect(findToolSearchExecutionContractFailures(items)).toEqual([]);
    expect(resolveToolSearchExecutionContract(taskResult.tools[0]!)).toMatchObject({
      executable: true,
      definitionName: 'Task',
      canonicalInvocation: 'Task',
    });
    expect(resolveToolSearchExecutionContract(mcpResult.tools[0]!)).toMatchObject({
      executable: true,
      definitionName: 'mcp__github__search_code',
      canonicalInvocation: 'mcp__github__search_code',
    });
    expect(resolveToolSearchExecutionContract(desktopResult.tools[0]!)).toMatchObject({
      executable: false,
      reason: expect.stringMatching(/Desktop workbench|no registered protocol tool/i),
    });
  });

  it('returns full design canvas tool definitions with non-empty parameters/description', () => {
    const definitions = getDesignCanvasToolDefinitions();
    const names = definitions.map((definition) => definition.name);

    expect(names).toContain('ProposeCanvasOps');
    expect(names).toContain('RequestDesignAutonomy');
    expect(names).toContain('ProposeVideoOps');
    expect(names).toContain('ProposeSlidesOps');
    expect(definitions).toHaveLength(4);

    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputSchema).toBeTruthy();
      expect(definition.inputSchema.type).toBe('object');
      expect(Object.keys(definition.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('registers design canvas tools as DEFERRED (discoverable by intent) but keeps them out of CORE_TOOLS', () => {
    // 意图驱动发现：画布工具进 DEFERRED 索引，agent 任何会话都能按意图 ToolSearch 搜到/select。
    const deferredNames = new Set(DEFERRED_TOOLS_META.map((meta) => meta.name));
    for (const name of ['ProposeCanvasOps', 'RequestDesignAutonomy']) {
      expect(CORE_TOOLS).not.toContain(name); // DEFERRED 不是 CORE
      expect(deferredNames.has(name)).toBe(true); // 但要在 DEFERRED 索引里
    }
  });

  it('keeps design canvas tools out of the normal-session base table (zero pollution invariant)', () => {
    // 硬不变量：DEFERRED ≠ 进基础表。普通会话工具表 = core + 已加载 deferred；
    // 未搜索/未激活设计会话时，基础表绝不含画布工具。
    const normalSessionNames = new Set([
      ...getCoreToolDefinitions().map((d) => d.name),
      ...getLoadedDeferredToolDefinitions().map((d) => d.name),
    ]);
    expect(normalSessionNames.has('ProposeCanvasOps')).toBe(false);
    expect(normalSessionNames.has('RequestDesignAutonomy')).toBe(false);
  });

  describe('withDesignCanvasTools (inference assembly injection)', () => {
    const baseTools = () => getCoreToolDefinitions();

    it('appends canvas tools when designCanvasActive === true', () => {
      const base = baseTools();
      const result = withDesignCanvasTools(base, true);
      const names = result.map((t) => t.name);

      expect(names).toContain('ProposeCanvasOps');
      expect(names).toContain('RequestDesignAutonomy');
      // 基础工具原样保留
      for (const t of base) {
        expect(names).toContain(t.name);
      }
    });

    it('does NOT include canvas tools when designCanvasActive === false (normal session zero pollution)', () => {
      const result = withDesignCanvasTools(baseTools(), false);
      const names = result.map((t) => t.name);
      expect(names).not.toContain('ProposeCanvasOps');
      expect(names).not.toContain('RequestDesignAutonomy');
    });

    it('does NOT include canvas tools when designCanvasActive is undefined (normal session zero pollution)', () => {
      const result = withDesignCanvasTools(baseTools(), undefined);
      const names = result.map((t) => t.name);
      expect(names).not.toContain('ProposeCanvasOps');
      expect(names).not.toContain('RequestDesignAutonomy');
    });

    it('does not duplicate canvas tools when they are already present in the base table', () => {
      const base = [...baseTools(), ...getDesignCanvasToolDefinitions()];
      const result = withDesignCanvasTools(base, true);
      const proposeCount = result.filter((t) => t.name === 'ProposeCanvasOps').length;
      const autonomyCount = result.filter((t) => t.name === 'RequestDesignAutonomy').length;
      expect(proposeCount).toBe(1);
      expect(autonomyCount).toBe(1);
    });
  });

  describe('withoutGenericMediaToolsInDesign (funnel 到画布工具)', () => {
    const withGenerics = (): { name: string }[] => [
      { name: 'Read' },
      { name: 'image_generate' },
      { name: 'video_generate' },
      { name: 'image_annotate' },
      { name: 'ProposeVideoOps' },
    ];

    it('designCanvasActive === true → 移除通用 image/video/annotate 工具，保留画布工具', () => {
      const result = withoutGenericMediaToolsInDesign(withGenerics() as never, true);
      const names = result.map((t) => t.name);
      expect(names).not.toContain('image_generate');
      expect(names).not.toContain('video_generate');
      expect(names).not.toContain('image_annotate');
      expect(names).toContain('ProposeVideoOps');
      expect(names).toContain('Read');
    });

    it('designCanvasActive 假/undefined → 原样保留（普通会话零影响）', () => {
      for (const active of [false, undefined] as const) {
        const names = withoutGenericMediaToolsInDesign(withGenerics() as never, active).map((t) => t.name);
        expect(names).toContain('image_generate');
        expect(names).toContain('video_generate');
      }
    });
  });

  it('flags a loadable ToolSearch result when no executable definition can resolve', () => {
    const item: ToolSearchItem = {
      name: 'phantom_tool',
      description: 'Bad metadata',
      score: 1,
      source: 'builtin',
      loadable: true,
      canonicalInvocation: 'phantom_tool',
    };

    expect(findToolSearchExecutionContractFailures([item], {
      resolveDefinition: () => undefined,
    })).toEqual([
      {
        name: 'phantom_tool',
        issue: 'loadable search result has no executable ToolDefinition: phantom_tool',
        item,
      },
    ]);
  });
});
