// ============================================================================
// key-gated tool availability Tests — N-TOOL-UNAVAILABLE-HINT
// ----------------------------------------------------------------------------
// 不变量（与 decide 的 route gating 同一套枚举收敛）：
//  1. 硬依赖外部 key 的四个工具（visual_edit / gui_agent / text_to_speech /
//     video_generate）key 缺失时不进 getDeferredToolDefinitions /
//     getLoadedDeferredToolDefinitions / deferred summary / ToolSearch；
//     key 配置后必须恢复出现（防「缺注册」假绿）。
//  2. read_pdf / youtube_transcript 有 keyless 降级路径（本地 pdftotext / 公共
//     fallback API），缺 key 也必须保持枚举——藏掉还能用的工具会让模型谎报能力缺失。
//  3. isToolAvailable 三态：key 缺失 false / key 在 true / 查找抛错 false 且
//     每工具只 warn 一次；未登记名恒 true（本表只做减法）。
// 全程 fake config + fake env——零真实 key、零网络。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getApiKeyMock: vi.fn<(provider: string) => string | undefined>(),
  resolveJevRoute: vi.fn<() => unknown>(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: hoisted.getApiKeyMock }),
}));

vi.mock('../../../../../src/host/model/providers/typesafeProvider', () => ({
  resolveJevRoute: hoisted.resolveJevRoute,
  systemOne: vi.fn(),
}));

vi.mock('../../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [] }),
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: hoisted.loggerWarn,
    error: vi.fn(),
  }),
}));

import {
  getDeferredToolDefinitions,
  getDeferredToolsSummary,
  getLoadedDeferredToolDefinitions,
} from '../../../../../src/host/tools/dispatch/toolDefinitions';
import {
  getToolSearchService,
  resetToolSearchService,
} from '../../../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry, getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { isToolAvailable } from '../../../../../src/host/tools/modules/network/toolAvailability';
import type { ToolSchema, ToolLoader } from '../../../../../src/host/protocol/tools';

const KEY_GATED_TOOLS = ['visual_edit', 'gui_agent', 'text_to_speech', 'video_generate'] as const;
const SEARCHABLE_KEY_GATED_TOOLS = ['visual_edit', 'text_to_speech', 'video_generate'] as const;
// gui_agent 不在 DEFERRED_TOOLS_META（本来就搜不到、不进 summary），枚举收敛只落
// 在 definitions 两处——这是登记面现状，不是本单漏网。
const KEYLESS_FALLBACK_TOOLS = ['read_pdf', 'youtube_transcript'] as const;

const ENV_KEYS = [
  'VOLCENGINE_API_KEY',
  'DOUBAO_API_KEY',
  'ZHIPU_OFFICIAL_API_KEY',
] as const;

function minimalSchema(name: string): ToolSchema {
  return {
    name,
    description: `minimal test schema for ${name}`,
    inputSchema: { type: 'object' } as ToolSchema['inputSchema'],
    outputSchema: { type: 'string' },
    category: 'network',
    permissionLevel: 'network',
  };
}

/** 与真实布局一致：plugin 工具（text_to_speech / video_generate / gui_agent）不随
 * registerMigratedTools 注册，测试里手动登记；builtin 的 read_pdf / youtube_transcript
 * 一并显式登记，测试不依赖 registerMigratedTools 的成员清单。loader 永不被 resolve。 */
function registerTestSchemas(): void {
  const registry = getProtocolRegistry();
  const loader: ToolLoader = async () => ({
    schema: minimalSchema('unused'),
    createHandler: async () => ({
      schema: minimalSchema('unused'),
      execute: async () => ({ ok: true, output: '' }),
    }),
  });
  for (const name of [...KEY_GATED_TOOLS, ...KEYLESS_FALLBACK_TOOLS]) {
    registry.register(minimalSchema(name), loader);
  }
}

/** key 全缺：configService 对任何 provider 返回 undefined，相关 env 清空。 */
function clearAllKeys(): void {
  hoisted.getApiKeyMock.mockReset().mockReturnValue(undefined);
  for (const key of ENV_KEYS) delete process.env[key];
}

/** key 全配：zhipu 走 config，火山/豆包与智谱官方视频走 env（与各 handler 的查找同源）。 */
function configureAllKeys(): void {
  hoisted.getApiKeyMock.mockReset().mockImplementation((provider: string) =>
    provider === 'zhipu' ? 'fake-zhipu-key' : undefined);
  process.env.VOLCENGINE_API_KEY = 'fake-volcengine-key';
  process.env.ZHIPU_OFFICIAL_API_KEY = 'fake-zhipu-official-key';
}

const savedEnv = new Map<string, string | undefined>();

describe('key-gated tool availability（N-TOOL-UNAVAILABLE-HINT）', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
    }
    clearAllKeys();
    hoisted.resolveJevRoute.mockReset().mockReturnValue(null);
    hoisted.loggerWarn.mockClear();
    resetProtocolRegistry();
    resetToolSearchService();
    registerTestSchemas();
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('isToolAvailable 三态（零真实 key）', () => {
    it('未登记的名字恒 true（本表只做减法，永不误藏）', () => {
      expect(isToolAvailable('Read')).toBe(true);
      expect(isToolAvailable('never-registered-tool')).toBe(true);
    });

    it.each(KEY_GATED_TOOLS)('%s：key 缺失 → false，key 配置 → true', (tool) => {
      clearAllKeys();
      expect(isToolAvailable(tool)).toBe(false);
      configureAllKeys();
      expect(isToolAvailable(tool)).toBe(true);
    });

    it('查找抛错 → false，且每个工具只 warn 一次，key 恢复后可用性恢复', () => {
      clearAllKeys();
      hoisted.getApiKeyMock.mockImplementation(() => {
        throw new Error('config boom');
      });
      expect(isToolAvailable('visual_edit')).toBe(false);
      expect(isToolAvailable('visual_edit')).toBe(false);
      const visualEditWarnings = hoisted.loggerWarn.mock.calls.filter(([message]) =>
        String(message).includes('visual_edit'));
      expect(visualEditWarnings).toHaveLength(1);

      expect(isToolAvailable('text_to_speech')).toBe(false);
      expect(isToolAvailable('video_generate')).toBe(false);

      configureAllKeys();
      expect(isToolAvailable('visual_edit')).toBe(true);
      expect(isToolAvailable('video_generate')).toBe(true);
    });

    it('video_generate：config 里的智谱 key 带 oki- 代理前缀不算官方视频 key', () => {
      process.env.ZHIPU_OFFICIAL_API_KEY = '';
      hoisted.getApiKeyMock.mockReturnValue('oki-proxy-key');
      expect(isToolAvailable('video_generate')).toBe(false);
      hoisted.getApiKeyMock.mockReturnValue('plain-zhipu-key');
      expect(isToolAvailable('video_generate')).toBe(true);
    });
  });

  describe('枚举收敛（与 decide 同位）', () => {
    it('key 缺失：四个工具不进 deferred 枚举 / summary / ToolSearch，select 加载也不进表', async () => {
      const deferredNames = getDeferredToolDefinitions().map((definition) => definition.name);
      for (const tool of KEY_GATED_TOOLS) {
        expect(deferredNames).not.toContain(tool);
      }

      const summary = getDeferredToolsSummary();
      for (const tool of SEARCHABLE_KEY_GATED_TOOLS) {
        expect(summary).not.toContain(tool);
      }
      // gui_agent 本就不在 DEFERRED_TOOLS_META，summary 两个状态都不含（登记面现状）
      expect(summary).not.toContain('gui_agent');

      for (const tool of SEARCHABLE_KEY_GATED_TOOLS) {
        const search = await getToolSearchService().searchTools(tool, { maxResults: 20 });
        expect(search.tools.map((result) => result.name)).not.toContain(tool);
      }

      getToolSearchService().selectTool('text_to_speech');
      expect(
        getLoadedDeferredToolDefinitions().map((definition) => definition.name),
      ).not.toContain('text_to_speech');
    });

    it('key 配置后四个工具恢复出现（防「缺注册」假绿）', async () => {
      configureAllKeys();

      const deferredNames = getDeferredToolDefinitions().map((definition) => definition.name);
      for (const tool of KEY_GATED_TOOLS) {
        expect(deferredNames).toContain(tool);
      }

      const summary = getDeferredToolsSummary();
      for (const tool of SEARCHABLE_KEY_GATED_TOOLS) {
        expect(summary).toContain(tool);
      }

      for (const tool of SEARCHABLE_KEY_GATED_TOOLS) {
        const search = await getToolSearchService().searchTools(tool, { maxResults: 20 });
        expect(search.tools.map((result) => result.name)).toContain(tool);
      }

      getToolSearchService().selectTool('text_to_speech');
      expect(
        getLoadedDeferredToolDefinitions().map((definition) => definition.name),
      ).toContain('text_to_speech');
    });

    it('read_pdf / youtube_transcript 缺 key 仍枚举（handler 有 keyless 降级路径）', async () => {
      const deferredNames = getDeferredToolDefinitions().map((definition) => definition.name);
      for (const tool of KEYLESS_FALLBACK_TOOLS) {
        expect(deferredNames).toContain(tool);
      }
      expect(getDeferredToolsSummary()).toContain('read_pdf');

      const search = await getToolSearchService().searchTools('read_pdf', { maxResults: 20 });
      expect(search.tools.map((result) => result.name)).toContain('read_pdf');
    });

    it('gui_agent 不在 ToolSearch 元数据里，两个状态都搜不到（收敛只落 definitions）', async () => {
      clearAllKeys();
      const withoutKey = await getToolSearchService().searchTools('gui_agent', { maxResults: 20 });
      expect(withoutKey.tools.map((result) => result.name)).not.toContain('gui_agent');

      configureAllKeys();
      const withKey = await getToolSearchService().searchTools('gui_agent', { maxResults: 20 });
      expect(withKey.tools.map((result) => result.name)).not.toContain('gui_agent');
    });
  });
});
