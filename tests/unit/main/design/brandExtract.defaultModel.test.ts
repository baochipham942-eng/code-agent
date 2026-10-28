import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  getVisionPreflightCandidates: vi.fn((_seed: unknown) => [] as unknown[]),
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getVisionPreflightCandidates(seed: unknown) {
      return h.getVisionPreflightCandidates(seed);
    }
    inference() {
      return Promise.resolve({ content: '' });
    }
  },
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

import { extractBrandFromImage } from '../../../../src/host/services/design/brandExtract';

const dataUrl = 'data:image/png;base64,AAAA';

function seed(): { provider: string; model: string; maxTokens: number } {
  const request = h.getVisionPreflightCandidates.mock.calls[0]?.[0];
  if (!request || typeof request !== 'object') throw new Error('missing vision seed');
  return request as { provider: string; model: string; maxTokens: number };
}

describe('brandExtract vision seed', () => {
  beforeEach(() => {
    h.getVisionPreflightCandidates.mockClear();
    h.getVisionPreflightCandidates.mockReturnValue([]);
    h.settings.models.default = '';
    h.settings.models.providers = {};
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network blocked');
    }));
  });

  it('seeds candidates from the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    await expect(extractBrandFromImage({ dataUrl })).rejects.toThrow(/视觉模型/);

    expect(seed()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: MODEL_MAX_TOKENS.VISION,
    });
  });

  it('seeds the factory default when nothing is configured', async () => {
    await expect(extractBrandFromImage({ dataUrl })).rejects.toThrow(/视觉模型/);

    expect(seed()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS.chat,
      maxTokens: MODEL_MAX_TOKENS.VISION,
    });
  });
});
