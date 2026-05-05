// ============================================================================
// speech_to_text (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, statSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024 }),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('audio-data')),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { speechToTextModule, executeSpeechToText } from '../../../../../src/main/tools/modules/network/speechToText';

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

describe('speech_to_text — schema', () => {
  it('declares correct name and category', () => {
    expect(speechToTextModule.schema.name).toBe('speech_to_text');
    expect(speechToTextModule.schema.category).toBe('network');
    expect(speechToTextModule.schema.permissionLevel).toBe('network');
    expect(speechToTextModule.schema.readOnly).toBe(true);
    expect(speechToTextModule.schema.allowInPlanMode).toBe(true);
  });

  it('requires file_path', () => {
    expect(speechToTextModule.schema.inputSchema.required).toEqual(['file_path']);
  });
});

describe('speech_to_text — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 1024 });
    readFileSyncMock.mockReturnValue(Buffer.from('audio-data'));
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('test-zhipu-key'),
    });
  });

  it('happy path returns transcribed text', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello world', id: 'task-1' }),
    });

    const result = await executeSpeechToText(
      { file_path: '/abs/path/audio.wav' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('hello world');
      expect(result.meta?.model).toBe('glm-asr-2512');
      expect(result.meta?.textLength).toBe(11);
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
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
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing file_path', async () => {
    const result = await executeSpeechToText({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects when api key missing', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
    }
  });

  it('rejects non-existent file', async () => {
    existsSyncMock.mockReturnValue(false);
    const result = await executeSpeechToText(
      { file_path: '/abs/missing.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('rejects unsupported format', async () => {
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.txt' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('不支持的音频格式');
    }
  });

  it('rejects oversize file', async () => {
    statSyncMock.mockReturnValue({ size: 30 * 1024 * 1024 });
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('文件过大');
    }
  });

  it('returns API error message on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });
    const result = await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('智谱 ASR API 错误');
    }
  });

  it('emits starting and completing onProgress', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'transcript' }),
    });
    const onProgress = vi.fn();
    await executeSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'speech_to_text' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('forwards optional hotwords and prompt to API body', async () => {
    let capturedBody: unknown = null;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      capturedBody = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve({ ok: true, json: async () => ({ text: 'ok' }) });
    });
    await executeSpeechToText(
      { file_path: '/abs/audio.wav', hotwords: 'AI,GLM', prompt: 'tech talk' },
      makeCtx(),
      allowAll,
    );
    expect(capturedBody).toMatchObject({
      hotwords: 'AI,GLM',
      prompt: 'tech talk',
      model: 'glm-asr-2512',
    });
  });
});
