import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getApiKeyMock,
  getModelForCapabilityMock,
  getSettingsMock,
  getModelInfoMock,
  getVisionPreflightCandidatesMock,
  inferenceWithVisionMock,
  readFileSyncMock,
  loggerMock,
} = vi.hoisted(() => ({
  getApiKeyMock: vi.fn(),
  getModelForCapabilityMock: vi.fn(),
  getSettingsMock: vi.fn(),
  getModelInfoMock: vi.fn(),
  getVisionPreflightCandidatesMock: vi.fn(),
  inferenceWithVisionMock: vi.fn(),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('png-data')),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getZhipuOfficialKey: () => getApiKeyMock(),
    getApiKey: (provider: string) => getApiKeyMock(provider),
    getModelForCapability: (capability: string) => getModelForCapabilityMock(capability),
    getSettings: () => getSettingsMock(),
  }),
}));

vi.mock('../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    getModelInfo(provider: string, model: string) {
      return getModelInfoMock(provider, model);
    }
    getVisionPreflightCandidates(...args: unknown[]) {
      return getVisionPreflightCandidatesMock(...args);
    }
    inferenceWithVision(...args: unknown[]) {
      return inferenceWithVisionMock(...args);
    }
  },
}));

vi.mock('../../../../src/host/runtime/sharpRuntime', () => ({
  loadSharp: () => ({
    ok: false,
    error: 'sharp not available in unit test',
    missingPackage: true,
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  promises: {
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  analyzeImageWithVision,
  analyzeImageWithVisionDetailed,
} from '../../../../src/host/services/desktop/visionAnalysisService';

const HAPPY_VISION_ROUTING = { provider: 'zhipu' as const, model: 'glm-4.6v' };
const HAPPY_MODEL_INFO = { supportsVision: true };

describe('visionAnalysisService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getApiKeyMock.mockReturnValue('test-vision-key');
    getModelForCapabilityMock.mockReturnValue(HAPPY_VISION_ROUTING);
    getSettingsMock.mockReturnValue({ models: { providers: {} } });
    getModelInfoMock.mockReturnValue(HAPPY_MODEL_INFO);
    getVisionPreflightCandidatesMock.mockReturnValue([
      {
        provider: HAPPY_VISION_ROUTING.provider,
        model: HAPPY_VISION_ROUTING.model,
        apiKey: 'test-vision-key',
        temperature: 0.3,
        maxTokens: 2048,
      },
    ]);
    readFileSyncMock.mockReturnValue(Buffer.from('png-data'));
  });

  it('returns missing_api_key when no configured candidate supports vision', async () => {
    getModelInfoMock.mockReturnValue({ supportsVision: false });
    getVisionPreflightCandidatesMock.mockReturnValue([]);

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'missing_api_key',
      retryable: false,
    });
    expect(inferenceWithVisionMock).not.toHaveBeenCalled();
  });

  it('returns missing_api_key when preflight finds no usable candidate', async () => {
    getModelForCapabilityMock.mockReturnValue(undefined);
    getVisionPreflightCandidatesMock.mockReturnValue([]);

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_api_key',
      retryable: false,
    });
    expect(inferenceWithVisionMock).not.toHaveBeenCalled();
  });

  it('returns exception when ModelRouter throws an HTTP-like error', async () => {
    inferenceWithVisionMock.mockRejectedValue(new Error('HTTP 403 model_not_allowed'));

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'exception',
      retryable: true,
    });
    if (!result.ok) {
      expect(result.error).toContain('model_not_allowed');
    }
  });

  it('returns timeout when ModelRouter call exceeds timeoutMs', async () => {
    inferenceWithVisionMock.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ content: 'never' }), 5_000)),
    );

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'timeout',
      retryable: true,
    });
    if (!result.ok) {
      expect(result.error).toContain('5ms');
    }
  });

  it('returns exception when image preparation fails (e.g. unreadable file)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'exception',
      retryable: true,
    });
    if (!result.ok) {
      expect(result.error).toContain('disk read failed');
    }
  });

  it('returns empty_response when ModelRouter returns no content', async () => {
    inferenceWithVisionMock.mockResolvedValue({ content: '   ' });

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'empty_response',
      retryable: true,
    });
  });

  it('keeps the legacy string API as nullable analysis text on success', async () => {
    inferenceWithVisionMock.mockResolvedValue({
      content: 'screen text',
      actualProvider: 'zhipu',
      actualModel: 'glm-4.6v',
    });

    await expect(analyzeImageWithVision({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    })).resolves.toBe('screen text');
  });

  it('returns ok=true with actualModel echoed back', async () => {
    inferenceWithVisionMock.mockResolvedValue({
      content: 'a cat picture',
      actualProvider: 'openai',
      actualModel: 'gpt-4o',
    });
    getModelForCapabilityMock.mockReturnValue({ provider: 'openai', model: 'gpt-4o' });

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({ ok: true, analysis: 'a cat picture', model: 'gpt-4o' });
  });
});
