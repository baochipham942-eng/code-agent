// ============================================================================
// 多模态桥接 Spec 1 音乐最后一公里 · U1 — resolveMusicModelEndpoint 共享端点解析
//
// 内置 minimax-music-2.6 → getMinimaxApiKey + MODEL_API_ENDPOINTS.minimax + music-2.6；
// 桥接 provider:model（musicGen 能力）→ deriveBridgedVisualModels 能力闸 + resolveBridgedEndpoint；
// 未知 id 抛错；缺 minimax key 抛错（不付费）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  getMinimaxApiKey: vi.fn(() => 'sk-minimax'),
  // 真实模块还导出 fetchWithAbort，本测试用不到，给个占位避免 named import 误用。
  fetchWithAbort: vi.fn(),
}));

vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({
  resolveBridgedEndpoint: vi.fn(() => ({ baseUrl: 'https://bridge.example.com/v1', apiKey: 'bk' })),
}));

const IMG_SVC = '../../../src/host/services/media/imageGenerationService';
const BRIDGE = '../../../src/host/services/media/bridgedEndpoint';

// 完整 provider 配置：deriveBridgedVisualModels 需 apiKeyConfigured + models[*].capabilities 才派生条目。
const settings = {
  models: {
    providers: {
      'custom-x': {
        displayName: 'X', baseUrl: 'https://bridge.example.com/v1', apiKeyConfigured: true, enabled: true,
        models: {
          'some-music': { capabilities: ['musicGen'], enabled: true },
          'chat-model': { capabilities: ['general'], enabled: true },
        },
      },
    },
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveMusicModelEndpoint', () => {
  it('内置 minimax-music-2.6 → music-2.6 + minimax 端点 + key', async () => {
    const { resolveMusicModelEndpoint } = await import('../../../src/host/services/media/musicGenerationService');
    const res = resolveMusicModelEndpoint('minimax-music-2.6', null);
    expect(res.modelName).toBe('music-2.6');
    expect(res.apiKey).toBe('sk-minimax');
    expect(res.baseUrl).toMatch(/^https?:\/\//);
  });

  it('桥接 provider:model（musicGen）→ resolveBridgedEndpoint + entry.modelName', async () => {
    const bridge = await import(BRIDGE);
    const { resolveMusicModelEndpoint } = await import('../../../src/host/services/media/musicGenerationService');
    const res = resolveMusicModelEndpoint('custom-x:some-music', settings);
    expect(res).toEqual({ baseUrl: 'https://bridge.example.com/v1', apiKey: 'bk', modelName: 'some-music' });
    expect((bridge.resolveBridgedEndpoint as any).mock.calls[0][0]).toBe('custom-x');
  });

  it('含冒号但非音乐能力 id（chat-model）→ 能力闸抛错', async () => {
    const { resolveMusicModelEndpoint } = await import('../../../src/host/services/media/musicGenerationService');
    expect(() => resolveMusicModelEndpoint('custom-x:chat-model', settings)).toThrow(/未知或不支持的桥接音乐模型/);
  });

  it('未知内置 id（无冒号、非 minimax-music-2.6）→ 抛错', async () => {
    const { resolveMusicModelEndpoint } = await import('../../../src/host/services/media/musicGenerationService');
    expect(() => resolveMusicModelEndpoint('random-id', null)).toThrow(/未知音乐模型/);
  });

  it('缺 minimax key → 抛错不付费', async () => {
    const img = await import(IMG_SVC);
    (img.getMinimaxApiKey as any).mockReturnValueOnce(undefined);
    const { resolveMusicModelEndpoint } = await import('../../../src/host/services/media/musicGenerationService');
    expect(() => resolveMusicModelEndpoint('minimax-music-2.6', null)).toThrow(/MiniMax API Key/);
  });
});
