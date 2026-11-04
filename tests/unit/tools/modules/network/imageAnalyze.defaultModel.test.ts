import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../../src/host/protocol/tools';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  getVisionPreflightCandidates: vi.fn((_seed: unknown) => [] as unknown[]),
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getVisionPreflightCandidates(seed: unknown) {
      return h.getVisionPreflightCandidates(seed);
    }
  },
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

import { executeImageAnalyze } from '../../../../../src/host/tools/modules/network/imageAnalyze';

const allowAll: CanUseToolFn = async () => ({ allow: true });

function ctx(modelConfig?: { provider: string; model: string }): ToolContext {
  return {
    sessionId: 's',
    workingDir: '/tmp/work',
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: () => undefined,
    ...(modelConfig ? { modelConfig } : {}),
  } as unknown as ToolContext;
}

function seed(): { provider: string; model: string; maxTokens?: number } {
  const request = h.getVisionPreflightCandidates.mock.calls[0]?.[0];
  if (!request || typeof request !== 'object') throw new Error('missing vision seed');
  return request as { provider: string; model: string; maxTokens?: number };
}

describe('imageAnalyze vision seed', () => {
  beforeEach(() => {
    h.getVisionPreflightCandidates.mockClear();
    h.getVisionPreflightCandidates.mockReturnValue([]);
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  it('seeds candidates from the configured user provider when ctx.modelConfig is absent', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    const result = await executeImageAnalyze({ path: '/tmp/missing.png' }, ctx(), allowAll);

    expect(result.ok).toBe(false);
    expect(seed()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 2048,
    });
  });

  it('keeps ctx.modelConfig ahead of the configured default', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    await executeImageAnalyze(
      { path: '/tmp/missing.png' },
      ctx({ provider: 'openai', model: 'gpt-5.5' }),
      allowAll,
    );

    expect(seed()).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('seeds the factory default when nothing is configured and ctx.modelConfig is absent', async () => {
    await executeImageAnalyze({ path: '/tmp/missing.png' }, ctx(), allowAll);

    expect(seed()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS.chat,
      maxTokens: 2048,
    });
  });
});
