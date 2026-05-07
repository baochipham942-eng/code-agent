// ============================================================================
// text_to_speech (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { textToSpeechModule, executeTextToSpeech } from '../../../../../src/main/tools/modules/network/textToSpeech';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('text_to_speech — schema', () => {
  it('declares correct name and category', () => {
    expect(textToSpeechModule.schema.name).toBe('text_to_speech');
    expect(textToSpeechModule.schema.category).toBe('network');
    expect(textToSpeechModule.schema.permissionLevel).toBe('network');
    expect(textToSpeechModule.schema.readOnly).toBe(false);
  });

  it('requires text', () => {
    expect(textToSpeechModule.schema.inputSchema.required).toEqual(['text']);
  });

  it('lists 8 voice options', () => {
    const voiceField = (textToSpeechModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).voice;
    expect(voiceField.enum).toHaveLength(8);
    expect(voiceField.enum).toContain('female');
    expect(voiceField.enum).toContain('彤彤');
  });
});

describe('text_to_speech — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('test-zhipu-key'),
    });
  });

  it('returns base64 when no output_path', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });

    const result = await executeTextToSpeech(
      { text: '你好' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('base64');
      expect(result.meta?.audioSizeBytes).toBe(4);
      expect(result.meta?.outputPath).toBeUndefined();
      expect(result.meta?.artifact).toMatchObject({
        kind: 'audio',
        sourceTool: 'text_to_speech',
        mimeType: 'audio/wav',
        contentLength: 4,
        metadata: {
          embeddedBase64: true,
          mediaKind: 'audio',
          model: 'glm-tts',
        },
      });
      expect(result.meta?.mediaKind).toBe('audio');
      expect(result.meta?.contentLength).toBe(4);
      expect(result.meta?.truncated).toBe(true);
    }
  });

  it('saves to file when output_path given', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });

    const result = await executeTextToSpeech(
      { text: '你好', output_path: '/tmp/work/out.wav' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.output).toContain('已保存到');
      expect(result.meta?.outputPath).toBe('/tmp/work/out.wav');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'audio',
        sourceTool: 'text_to_speech',
        path: '/tmp/work/out.wav',
        mimeType: 'audio/wav',
        metadata: {
          mediaKind: 'audio',
          model: 'glm-tts',
        },
      });
    }
  });

  it('appends correct extension to output_path if missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });

    const result = await executeTextToSpeech(
      { text: '你好', output_path: '/tmp/work/out' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.outputPath).toBe('/tmp/work/out.wav');
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeTextToSpeech(
      { text: '你好' },
      makeCtx(),
      async () => ({ allow: false, reason: 'no perm' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeTextToSpeech(
      { text: '你好' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects empty text', async () => {
    const result = await executeTextToSpeech(
      { text: '   ' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('文本不能为空');
    }
  });

  it('rejects oversize text', async () => {
    const result = await executeTextToSpeech(
      { text: 'a'.repeat(2001) },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('文本过长');
    }
  });

  it('rejects out-of-range speed', async () => {
    const result = await executeTextToSpeech(
      { text: '你好', speed: 3.0 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('语速');
    }
  });

  it('rejects unknown voice', async () => {
    const result = await executeTextToSpeech(
      { text: '你好', voice: 'martian' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('不支持的声音类型');
    }
  });

  it('rejects when api key missing', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    const result = await executeTextToSpeech(
      { text: '你好' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
    }
  });

  it('returns API error message on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });
    const result = await executeTextToSpeech(
      { text: '你好' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('智谱 TTS API 错误');
    }
  });

  it('emits onProgress', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    const onProgress = vi.fn();
    await executeTextToSpeech(
      { text: '你好' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'text_to_speech' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
