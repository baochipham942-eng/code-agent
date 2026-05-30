// ============================================================================
// local_speech_to_text (native ToolModule) Tests
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';

const {
  existsSyncMock,
  unlinkSyncMock,
  execFileAsyncMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  unlinkSyncMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: () => execFileAsyncMock,
}));

import {
  executeLocalSpeechToText,
  localSpeechToTextModule,
} from '../../../../../src/main/tools/modules/network/localSpeechToText';

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
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('local_speech_to_text - schema', () => {
  it('declares correct name and category', () => {
    expect(localSpeechToTextModule.schema.name).toBe('local_speech_to_text');
    expect(localSpeechToTextModule.schema.category).toBe('network');
    expect(localSpeechToTextModule.schema.permissionLevel).toBe('read');
    expect(localSpeechToTextModule.schema.readOnly).toBe(true);
    expect(localSpeechToTextModule.schema.allowInPlanMode).toBe(true);
  });

  it('requires file_path', () => {
    expect(localSpeechToTextModule.schema.inputSchema.required).toEqual(['file_path']);
  });
});

describe('local_speech_to_text - execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    execFileAsyncMock.mockResolvedValue({
      stdout: '[00:00.000 --> 00:01.000] hello world\n',
      stderr: '',
    });
  });

  it('happy path returns transcribed text', async () => {
    const result = await executeLocalSpeechToText(
      { file_path: '/abs/path/audio.wav' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('hello world');
      expect(result.meta?.model).toBe('ggml-large-v3-turbo.bin');
      expect(result.meta?.textLength).toBe(11);
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'local_speech_to_text',
        mimeType: 'text/plain',
        contentLength: 11,
        metadata: {
          sourcePath: '/abs/path/audio.wav',
          mediaKind: 'audio',
          artifactRole: 'transcript',
        },
      });
      expect(result.meta?.mediaKind).toBe('audio');
      expect(result.meta?.contentLength).toBe(11);
      expect(result.meta?.truncated).toBe(false);
    }
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

  it('rejects when whisper-cpp is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    execFileAsyncMock.mockRejectedValue(new Error('not found'));

    const result = await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
    }
  });

  it('rejects non-existent source file after finding whisper-cpp', async () => {
    existsSyncMock.mockImplementation((target: string) => !target.includes('/missing.'));

    const result = await executeLocalSpeechToText(
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

  it('returns empty result error when whisper output has no transcript', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
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

  it('emits starting and completing onProgress', async () => {
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

  it('forwards optional language/model/threads flags to whisper-cpp', async () => {
    await executeLocalSpeechToText(
      { file_path: '/abs/audio.wav', language: 'en', model: 'base', threads: 2, output_format: 'vtt', translate: true },
      makeCtx(),
      allowAll,
    );

    const [, args] = execFileAsyncMock.mock.calls.at(-1)!;
    expect(args).toEqual(expect.arrayContaining([
      '-l',
      'en',
      '-t',
      '2',
      '--output-vtt',
      '--translate',
    ]));
    expect(args).toEqual(expect.arrayContaining([
      expect.stringContaining('ggml-base.bin'),
    ]));
  });
});
