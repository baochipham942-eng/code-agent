// ============================================================================
// local_speech_to_text (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, unlinkSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  unlinkSyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        (fn as (...a: unknown[]) => void)(...args, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
  },
}));

import { localSpeechToTextModule, executeLocalSpeechToText } from '../../../../../src/main/tools/modules/network/localSpeechToText';

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

interface ExecCallback {
  (err: unknown, stdout: string, stderr: string): void;
}

function mockExec(handler: (bin: string, args: string[]) => [unknown, string, string]) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const bin = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as ExecCallback;
    const [err, stdout, stderr] = handler(bin, args);
    cb(err, stdout, stderr);
  });
}

describe('local_speech_to_text — schema', () => {
  it('declares correct name and category', () => {
    expect(localSpeechToTextModule.schema.name).toBe('local_speech_to_text');
    expect(localSpeechToTextModule.schema.category).toBe('network');
    expect(localSpeechToTextModule.schema.permissionLevel).toBe('read');
    expect(localSpeechToTextModule.schema.readOnly).toBe(true);
  });

  it('requires file_path', () => {
    expect(localSpeechToTextModule.schema.inputSchema.required).toEqual(['file_path']);
  });
});

describe('local_speech_to_text — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    execFileMock.mockReset();
  });

  it('happy path: WAV → whisper text mode', async () => {
    mockExec(() => [null, '[00:00:00.000 --> 00:00:02.000]  你好世界\n[00:00:02.000 --> 00:00:04.000]  这是一段测试', '']);

    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('你好世界');
      expect(result.meta?.outputFormat).toBe('text');
    }
  });

  it('SRT format passes raw output through', async () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\n你好';
    mockExec(() => [null, srt, '']);

    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav', output_format: 'srt' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(srt);
    }
  });

  it('mp3 file triggers ffmpeg conversion', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    mockExec((bin, args) => {
      calls.push({ bin, args });
      return [null, '[00:00:00.000 --> 00:00:01.000]  test', ''];
    });

    await executeLocalSpeechToText(
      { file_path: '/abs/audio.mp3' },
      makeCtx(),
      allowAll,
    );

    const ffmpegCall = calls.find((c) => c.bin === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    if (ffmpegCall) {
      expect(ffmpegCall.args).toContain('-ar');
      expect(ffmpegCall.args).toContain('16000');
    }
    expect(unlinkSyncMock).toHaveBeenCalled();
  });

  it('forwards translate flag', async () => {
    const calls: Array<{ args: string[] }> = [];
    mockExec((_bin, args) => {
      calls.push({ args });
      return [null, '[00:00:00.000 --> 00:00:01.000]  hello', ''];
    });

    await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav', translate: true },
      makeCtx(),
      allowAll,
    );

    const whisperCall = calls.find((c) => c.args.includes('--translate'));
    expect(whisperCall).toBeDefined();
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeLocalSpeechToText(
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
    const result = await executeLocalSpeechToText(
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
    const result = await executeLocalSpeechToText({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('returns NOT_INITIALIZED when whisper-cpp missing', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('whisper-cpp')) return false;
      return true;
    });
    mockExec(() => [new Error('not found'), '', '']);

    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('whisper-cpp 未安装');
    }
  });

  it('rejects non-existent input file', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('audio.wav')) return false;
      return true;
    });
    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('rejects unsupported format', async () => {
    const result = await executeLocalSpeechToText(
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

  it('returns NOT_INITIALIZED when model file missing', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('ggml-')) return false;
      return true;
    });
    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('模型文件不存在');
    }
  });

  it('returns EMPTY_RESULT when whisper produces nothing', async () => {
    mockExec(() => [null, '', '']);
    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('EMPTY_RESULT');
    }
  });

  it('emits onProgress', async () => {
    mockExec(() => [null, '[00:00:00.000 --> 00:00:01.000]  ok', '']);
    const onProgress = vi.fn();
    await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'local_speech_to_text' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
