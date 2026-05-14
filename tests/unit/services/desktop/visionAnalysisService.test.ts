import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getApiKeyMock, readFileSyncMock, loggerMock } = vi.hoisted(() => ({
  getApiKeyMock: vi.fn(),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('png-data')),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({
    getZhipuOfficialKey: getApiKeyMock,
  }),
}));

vi.mock('sharp', () => ({
  // prepareImageForVision 走降级路径：sharp 抛错 → 回退用 readFileSync 原始字节
  default: () => {
    throw new Error('sharp not available in unit test');
  },
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

import {
  analyzeImageWithVision,
  analyzeImageWithVisionDetailed,
} from '../../../../src/main/services/desktop/visionAnalysisService';

describe('visionAnalysisService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getApiKeyMock.mockReturnValue('test-zhipu-key');
    readFileSyncMock.mockReturnValue(Buffer.from('png-data'));
  });

  it('returns missing_api_key when zhipu key is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getApiKeyMock.mockReturnValue(undefined);

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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns http_error with status and body for model_not_allowed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"model_not_allowed"}',
    }));

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'http_error',
      httpStatus: 403,
      retryable: false,
    });
    if (!result.ok) {
      expect(result.error).toContain('model_not_allowed');
    }
  });

  it('returns timeout when fetch is aborted', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

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

  it('returns exception for unexpected failures', async () => {
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

  it('keeps the legacy string API as nullable analysis text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'screen text' } }] }),
    }));

    await expect(analyzeImageWithVision({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    })).resolves.toBe('screen text');
  });
});
