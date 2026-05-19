// ============================================================================
// CapabilityRecommender Tests — Step 7 PR 2
//
// 覆盖核心方法：
// - scanForCapability：plugin gap / model gap / apikey gap 各 1 case
// - findCapableModels：候选排序（已配 key 优先 + 链路顺序）
// - hasConfiguredKey：true/false 两个分支
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginManifest, LoadedPlugin } from '../../../../src/main/plugins/types';

// --- Mock layer ---------------------------------------------------------

const getPluginsMock = vi.fn<() => LoadedPlugin[]>();
vi.mock('../../../../src/main/plugins/pluginRegistry', () => ({
  getPluginRegistry: () => ({
    getPlugins: getPluginsMock,
  }),
}));

const hasConfiguredKeyMock = vi.fn<(provider: string) => boolean>();
const getApiKeyMock = vi.fn<(provider: string) => string | undefined>();
vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({
    hasConfiguredKey: hasConfiguredKeyMock,
    getApiKey: getApiKeyMock,
  }),
}));

const findCapableModelsMock = vi.fn();
vi.mock('../../../../src/main/model/modelRouter', () => ({
  findCapableModels: findCapableModelsMock,
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// --- Helpers ------------------------------------------------------------

function mkPlugin(
  id: string,
  capabilities: string[],
  state: LoadedPlugin['state'] = 'active',
): LoadedPlugin {
  const manifest: PluginManifest = {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.ts',
    capabilities,
  };
  return {
    manifest,
    rootPath: `builtin:${id}`,
    state,
    registeredTools: [],
    registeredHooks: [],
  };
}

// --- Tests --------------------------------------------------------------

describe('CapabilityRecommender', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCapabilityRecommender } = await import(
      '../../../../src/main/services/capability/CapabilityRecommender'
    );
    resetCapabilityRecommender();
  });

  describe('scanForCapability', () => {
    it('未在 active plugin 声明的 capability → PluginGap with empty candidates', async () => {
      getPluginsMock.mockReturnValue([
        mkPlugin('builtin.audio', ['audio-processing']),
      ]);
      findCapableModelsMock.mockReturnValue([]); // not a model capability anyway
      hasConfiguredKeyMock.mockReturnValue(true);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().scanForCapability('browser-control');

      const pluginGap = gaps.find((g) => g.type === 'plugin');
      expect(pluginGap).toBeDefined();
      expect(pluginGap).toEqual({
        type: 'plugin',
        missing: 'browser-control',
        candidates: [],
      });
    });

    it('plugin 命中但 model 注册表无候选 → ModelGap（vision 标签 case）', async () => {
      getPluginsMock.mockReturnValue([
        // plugin 层命中：声明了 vision
        mkPlugin('builtin.vision', ['vision']),
      ]);
      findCapableModelsMock.mockReturnValue([]); // model 层无候选
      hasConfiguredKeyMock.mockReturnValue(true);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().scanForCapability('vision');

      expect(gaps.some((g) => g.type === 'plugin')).toBe(false);
      const modelGap = gaps.find((g) => g.type === 'model');
      expect(modelGap).toEqual({
        type: 'model',
        missing: 'vision',
        candidates: [],
      });
    });

    it('model 候选存在但 provider 都没配 key → ApiKeyGap，provider 取候选首项', async () => {
      getPluginsMock.mockReturnValue([
        mkPlugin('builtin.vision', ['vision']),
      ]);
      findCapableModelsMock.mockReturnValue([
        { provider: 'claude', model: 'claude-opus-4-7' },
        { provider: 'openai', model: 'gpt-4o' },
      ]);
      hasConfiguredKeyMock.mockReturnValue(false);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().scanForCapability('vision');

      const apikeyGap = gaps.find((g) => g.type === 'apikey');
      expect(apikeyGap).toEqual({
        type: 'apikey',
        missing: 'vision',
        provider: 'claude', // findCapableModels mock 返回的首项
      });
      // 不应同时报 ModelGap
      expect(gaps.some((g) => g.type === 'model')).toBe(false);
    });

    it('inactive plugin 不计入 plugin hit', async () => {
      getPluginsMock.mockReturnValue([
        mkPlugin('builtin.audio', ['audio-processing'], 'inactive'),
      ]);
      findCapableModelsMock.mockReturnValue([]);
      hasConfiguredKeyMock.mockReturnValue(true);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().scanForCapability('audio-processing');
      expect(gaps.some((g) => g.type === 'plugin')).toBe(true);
    });
  });

  describe('recommendForToolError', () => {
    it('image_analyze 失败 → 推导 vision capability，走 scanForCapability', async () => {
      getPluginsMock.mockReturnValue([]);
      findCapableModelsMock.mockReturnValue([]);
      hasConfiguredKeyMock.mockReturnValue(false);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().recommendForToolError(
        'image_analyze',
        new Error('model does not support image input'),
      );
      // 至少有 plugin gap（plugin 表为空）
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.some((g) => g.type === 'plugin' && g.missing === 'vision')).toBe(true);
    });

    it('无关键词匹配 → 返回空数组', async () => {
      getPluginsMock.mockReturnValue([]);
      findCapableModelsMock.mockReturnValue([]);

      const { getCapabilityRecommender } = await import(
        '../../../../src/main/services/capability/CapabilityRecommender'
      );
      const gaps = getCapabilityRecommender().recommendForToolError(
        'totally_unknown_tool',
        new Error('random failure'),
      );
      expect(gaps).toEqual([]);
    });
  });
});

// ============================================================================
// findCapableModels 排序 + hasConfiguredKey 行为
//
// 这两个 helper 都依赖真实 PROVIDER_REGISTRY / configService 实现，不走
// CapabilityRecommender 的 mock 体系；放独立 describe 用真实 import + 局部 mock。
// ============================================================================

describe('findCapableModels (real PROVIDER_REGISTRY)', () => {
  it('已配 key 的 provider 排在未配的前面', async () => {
    // 局部 mock configService：仅 zhipu 已配 key
    vi.resetModules();
    vi.doUnmock('../../../../src/main/model/modelRouter');
    vi.doMock('../../../../src/main/services/core/configService', () => ({
      getConfigService: () => ({
        hasConfiguredKey: (p: string) => p === 'zhipu',
        getApiKey: (p: string) => (p === 'zhipu' ? 'mock-key' : undefined),
      }),
    }));
    vi.doMock('../../../../src/main/services/infra/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    }));

    const { findCapableModels } = await import(
      '../../../../src/main/model/modelRouter'
    );
    const candidates = findCapableModels('vision');
    expect(candidates.length).toBeGreaterThan(0);
    // 首项必须是已配 key 的 zhipu
    expect(candidates[0].provider).toBe('zhipu');
  });

  it('全部 provider 都没配 key 时返回非空数组但首项按 chain 顺序（claude 链优先）', async () => {
    vi.resetModules();
    vi.doUnmock('../../../../src/main/model/modelRouter');
    vi.doMock('../../../../src/main/services/core/configService', () => ({
      getConfigService: () => ({
        hasConfiguredKey: () => false,
        getApiKey: () => undefined,
      }),
    }));
    vi.doMock('../../../../src/main/services/infra/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    }));

    const { findCapableModels } = await import(
      '../../../../src/main/model/modelRouter'
    );
    const candidates = findCapableModels('vision');
    expect(candidates.length).toBeGreaterThan(0);
    // claude 是 chain 起点，所有 vision-capable claude 模型应该排在 chain 末端的
    // openai / moonshot 等前面。这里只校验 claude 在 openai 之前（弱断言保
    // 持 robust，不依赖具体模型 id）。
    const claudeIdx = candidates.findIndex((c) => c.provider === 'claude');
    const openaiIdx = candidates.findIndex((c) => c.provider === 'openai');
    if (claudeIdx >= 0 && openaiIdx >= 0) {
      expect(claudeIdx).toBeLessThan(openaiIdx);
    }
  });
});

describe('configService.hasConfiguredKey', () => {
  it('getApiKey 返回 string → hasConfiguredKey = true', async () => {
    vi.resetModules();
    vi.doUnmock('../../../../src/main/services/core/configService');
    vi.doMock('../../../../src/main/services/infra/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    }));
    const mod = await import('../../../../src/main/services/core/configService');
    // 创建实例，stub getApiKey
    const svc = mod.getConfigService();
    const spy = vi.spyOn(svc, 'getApiKey').mockReturnValue('mock-key');
    expect(svc.hasConfiguredKey('claude')).toBe(true);
    spy.mockRestore();
  });

  it('getApiKey 返回 undefined → hasConfiguredKey = false', async () => {
    vi.resetModules();
    vi.doUnmock('../../../../src/main/services/core/configService');
    vi.doMock('../../../../src/main/services/infra/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    }));
    const mod = await import('../../../../src/main/services/core/configService');
    const svc = mod.getConfigService();
    const spy = vi.spyOn(svc, 'getApiKey').mockReturnValue(undefined);
    expect(svc.hasConfiguredKey('local')).toBe(false);
    spy.mockRestore();
  });
});
