// 桌面视觉兜底 seed 的默认模型解析：routing.vision 未配置时，
// seed 从 resolveSessionDefaultModelConfig 取——用户配置的 models.default 优先，
// 未配置才落出厂默认。仿 brandExtract.defaultModel.test：candidates 置空，
// 走 missing_api_key 早退，任何字节都不发。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string; baseUrl?: string }>,
    },
  },
  getVisionPreflightCandidates: vi.fn((_seed: unknown) => [] as unknown[]),
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => 'test-key',
    getModelForCapability: () => undefined,
  }),
}));

vi.mock('../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getVisionPreflightCandidates(seed: unknown) {
      return h.getVisionPreflightCandidates(seed);
    }
    getModelInfo() {
      return null;
    }
    inferenceWithVision() {
      return Promise.resolve({ content: '' });
    }
  },
}));

import { analyzeImageWithVisionDetailed } from '../../../../src/host/services/desktop/visionAnalysisService';

function seed(): { provider: string; model: string; temperature: number; maxTokens: number } {
  const request = h.getVisionPreflightCandidates.mock.calls[0]?.[0];
  if (!request || typeof request !== 'object') throw new Error('missing vision seed');
  return request as { provider: string; model: string; temperature: number; maxTokens: number };
}

describe('vision fallback seed default model', () => {
  beforeEach(() => {
    h.getVisionPreflightCandidates.mockClear();
    h.getVisionPreflightCandidates.mockReturnValue([]);
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  it('seeds the fallback from the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.test/v1' } };

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/vision-test.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result.ok).toBe(false); // 无候选 → 早退，未发任何字节
    expect(seed()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 2048,
    });
  });

  it('seeds the fallback from the factory default when nothing is configured', async () => {
    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/vision-test.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result.ok).toBe(false);
    expect(seed()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS.chat,
      temperature: 0.3,
      maxTokens: 2048,
    });
  });
});
