import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getApiKeyMock,
  getModelForCapabilityMock,
  getSettingsMock,
  getModelInfoMock,
  getVisionPreflightCandidatesMock,
  inferenceWithVisionMock,
  readFileSyncMock,
  statSyncMock,
  loadSharpMock,
  sharpMetadataMock,
  sharpToFileSyncMock,
  loggerMock,
} = vi.hoisted(() => ({
  getApiKeyMock: vi.fn(),
  getModelForCapabilityMock: vi.fn(),
  getSettingsMock: vi.fn(),
  getModelInfoMock: vi.fn(),
  getVisionPreflightCandidatesMock: vi.fn(),
  inferenceWithVisionMock: vi.fn(),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('png-data')),
  statSyncMock: vi.fn().mockReturnValue({ size: 2048 }),
  loadSharpMock: vi.fn(),
  sharpMetadataMock: vi.fn(),
  sharpToFileSyncMock: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
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
  loadSharp: (...args: unknown[]) => loadSharpMock(...args),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
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

// 默认装一个「能干活」的 sharp stub：metadata 出 800x600、resize/toFile 全链路可走。
// sharp 失败/超限的用例在各自 it 里覆盖 loadSharpMock / sharpMetadataMock / statSyncMock。
function installWorkingSharpStub(): void {
  const instance: Record<string, unknown> = {};
  instance.metadata = (...args: unknown[]) => sharpMetadataMock(...args);
  instance.resize = vi.fn(() => instance);
  instance.png = vi.fn(() => instance);
  instance.toFile = (...args: unknown[]) => sharpToFileSyncMock(...args);
  const sharpModule = vi.fn(() => instance);
  loadSharpMock.mockReturnValue({ ok: true, sharp: sharpModule });
  sharpMetadataMock.mockResolvedValue({ width: 800, height: 600 });
  sharpToFileSyncMock.mockResolvedValue(undefined);
  statSyncMock.mockReturnValue({ size: 2048 });
}

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
    installWorkingSharpStub();
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

  it('returns image_too_large (non-retryable, no model call) when the image exceeds the byte cap', async () => {
    // 拿不到尺寸 → 走「原图直发」分支；statSync 报 9 MiB > 5 MiB 上限
    sharpMetadataMock.mockResolvedValue({});
    statSyncMock.mockReturnValue({ size: 9 * 1024 * 1024 });

    const result = await analyzeImageWithVisionDetailed({
      imagePath: '/tmp/screen.png',
      prompt: 'describe',
      source: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      analysis: null,
      reason: 'image_too_large',
      retryable: false,
    });
    if (!result.ok) {
      expect(result.error).toContain('9 MiB');
      expect(result.error).toContain('5 MiB vision limit');
    }
    expect(inferenceWithVisionMock).not.toHaveBeenCalled();
    // 超限文件在读入内存前就被拒
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns exception without fallback bytes when the sharp runtime is unavailable', async () => {
    loadSharpMock.mockReturnValue({
      ok: false,
      error: 'sharp not available in unit test',
      missingPackage: true,
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
      expect(result.error).toContain('sharp not available in unit test');
      expect(result.error).toContain('the image was not sent');
    }
    expect(inferenceWithVisionMock).not.toHaveBeenCalled();
    // 不再有「sharp 失败 → 回退原始字节」的降级
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns exception naming the sharp failure when a sharp step throws', async () => {
    sharpMetadataMock.mockRejectedValue(new Error('vips: bad image header'));

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
      expect(result.error).toContain('vips: bad image header');
      expect(result.error).toContain('the image was not sent');
    }
    expect(inferenceWithVisionMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
