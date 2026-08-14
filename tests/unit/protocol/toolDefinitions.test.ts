import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

const getServiceApiKey = vi.hoisted(() => vi.fn().mockReturnValue(undefined));

// 工具表初筛要读设置里的搜索 key；默认 mock 成「什么都没配」，单测不碰真实 SecureStorage。
vi.mock('../../../src/host/services/core/configService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfigService: () => ({ getServiceApiKey }),
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
    getServiceApiKey.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  // 2026-08-14（L8 N-L8-SLIM2）：Append 每轮占 306 token，真库 4748 次调用里只被用到 1 次，
  // 已挪进 deferred。同 EpisodicRecall——断言不删，升级到「能力不许丢」这一层。
  it('keeps Write core and Append reachable after Append moved out of the core table', () => {
    const names = getCoreToolDefinitions().map((definition) => definition.name);
    expect(names).toContain('Write');
    expect(names).not.toContain('Append');
    expect(getToolSearchService().selectTool('Append').tools[0]?.name).toBe('Append');
  });

  it('keeps ExternalSearch out of the tool table when no search credential is configured anywhere', () => {
    // 设置里没配（getServiceApiKey 全 undefined）且 env 无搜索变量 → 工具不进表。
    // 只配模型 key 不算数：mock 一个只认模型 provider 的 getter 也救不回来。
    vi.stubEnv('ZHIPU_OFFICIAL_API_KEY', '');
    vi.stubEnv('MINIMAX_SEARCH_API_KEY', '');
    getServiceApiKey.mockImplementation((service: string) => (service === 'zhipu' || service === 'minimax' ? 'model-key' : undefined));
    expect(getCoreToolDefinitions().map((definition) => definition.name)).not.toContain('ExternalSearch');
  });

  it('includes ExternalSearch once a dedicated search key is configured in settings', () => {
    // 用户在设置页配了 zhipu-search 的 key（env 为空）→ 工具必须出现在工具表。
    getServiceApiKey.mockImplementation((service: string) => (service === 'zhipu-search' ? 'settings-zhipu-key' : undefined));
    expect(getCoreToolDefinitions().map((definition) => definition.name)).toContain('ExternalSearch');
  });

  it('drops ExternalSearch when the per-turn search toggle is off, even with a configured credential', () => {
    // 逐轮开关（模型选择弹窗「联网搜索」）关掉时，ExternalSearch 不进工具表——
    // 哪怕凭据齐全。语义：这一轮不允许联网。
    getServiceApiKey.mockImplementation((service: string) => (service === 'zhipu-search' ? 'settings-zhipu-key' : undefined));
    expect(getCoreToolDefinitions({ searchEnabled: false }).map((definition) => definition.name))
      .not.toContain('ExternalSearch');
  });

  it('keeps ExternalSearch when the per-turn search toggle is explicitly on', () => {
    getServiceApiKey.mockImplementation((service: string) => (service === 'zhipu-search' ? 'settings-zhipu-key' : undefined));
    expect(getCoreToolDefinitions({ searchEnabled: true }).map((definition) => definition.name))
      .toContain('ExternalSearch');
  });

  it('does not put a permission prompt in front of AskUserQuestion itself', () => {
    const definition = getCoreToolDefinitions()
      .find((candidate) => candidate.name === 'AskUserQuestion');

    expect(definition).toMatchObject({
      permissionLevel: 'execute',
      requiresPermission: false,
      requiresUserPresence: true,
    });
  });

  // 本条守的不变量：关键词搜索命中一个**与 CORE 工具同名**的可搜索条目时，它不能被算进
  // 「已加载的 deferred 工具」——否则同一个工具会在工具表里出现两次。
  //
  // 2026-08-14（L8 N-L8-SLIM2）：原样本用的是 TaskManager，因为它当时是唯一一个同时登记在
  // CORE_TOOLS 和 DEFERRED_TOOLS_META 的工具。它挪进 deferred 后 CORE ∩ META = 空集，
  // 这个场景没有任何真实数据能构造了。改为注入一个与 CORE 工具 Grep 同名的 MCP 条目——
  // 这不是为了凑测试：MCP server 完全可能提供一个跟内置工具重名的工具，那时正是这段
  // isCoreToolName 短路在挡重复进表。
  it('keeps core tools out of loaded deferred definitions when a same-named entry is searchable', async () => {
    const service = getToolSearchService();
    service.registerMCPTool({
      name: 'Grep',
      shortDescription: 'a third-party tool that collides with the built-in Grep',
      tags: ['search'],
      aliases: ['grep', 'collider grep'],
      source: 'mcp',
      mcpServer: 'collider',
    });

    await service.searchTools('Grep', { maxResults: 3, includeMCP: true });

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('Grep');
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

  // 2026-08-14（L8 N-L8-SLIM2）：本断言原文是「EpisodicRecall 必须在 CORE_TOOLS 里」，
  // 来自 #349 把它加进 CORE 时钉的回归钉。真库 4748 次工具调用里它一次没被用到，而 schema
  // 每轮占 363 token，已随该批挪进 deferred。
  //
  // 断言没有删——删掉等于放任这个能力悄悄失联。它被升级到了正确的层面：#349 真正要守的是
  // 「这个能力不许丢」，而不是「它必须常驻」。挪进 deferred 后守的就是「模型仍找得回它」。
  it('keeps EpisodicRecall reachable after it moved out of the core table', () => {
    expect(CORE_TOOLS).not.toContain('EpisodicRecall');
    // 名字仍随每轮 deferred 索引下发，且 select: 稳定命中它自己（不是被 alias 串到别的工具）
    expect(DEFERRED_TOOLS_META.map((meta) => meta.name)).toContain('EpisodicRecall');
    expect(getToolSearchService().selectTool('EpisodicRecall').tools[0]?.name).toBe('EpisodicRecall');
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
      tags: [],
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
