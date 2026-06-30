// ============================================================================
// music_generate (native ToolModule) Tests — 音乐最后一公里 Spec1 · U2
//
// 成功路径：解析端点 → generateMusic → 写盘 → audio file artifact。
// 付费守门：缺 key / 未知 model → resolveMusicModelEndpoint 抛错，generateMusic 零调用。
// 空 prompt → INVALID_ARGS（generateMusic 零调用）。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

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
  getConfigServiceMock: vi.fn(() => ({ getSettings: () => null })),
}));

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

const { generateMusicMock, resolveMusicModelEndpointMock } = vi.hoisted(() => ({
  generateMusicMock: vi.fn(),
  resolveMusicModelEndpointMock: vi.fn(),
}));

vi.mock('../../../../../src/host/services/media/musicGenerationService', () => ({
  generateMusic: (...args: unknown[]) => generateMusicMock(...args),
  resolveMusicModelEndpoint: (...args: unknown[]) => resolveMusicModelEndpointMock(...args),
}));

import {
  musicGenerateModule,
  executeMusicGenerate,
} from '../../../../../src/host/plugins/builtin/musicGeneration/musicGenerate';

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

describe('music_generate — schema', () => {
  it('declares correct name and category', () => {
    expect(musicGenerateModule.schema.name).toBe('music_generate');
    expect(musicGenerateModule.schema.category).toBe('network');
    expect(musicGenerateModule.schema.permissionLevel).toBe('network');
    expect(musicGenerateModule.schema.allowInPlanMode).toBe(false);
  });

  it('requires prompt', () => {
    expect(musicGenerateModule.schema.inputSchema.required).toEqual(['prompt']);
  });
});

describe('music_generate — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    getConfigServiceMock.mockReturnValue({ getSettings: () => null });
    resolveMusicModelEndpointMock.mockReturnValue({
      baseUrl: 'https://api.minimax.chat/v1',
      apiKey: 'sk',
      modelName: 'music-2.6',
    });
    generateMusicMock.mockResolvedValue({
      audioBuffer: Buffer.from('mp3-bytes'),
      actualModel: 'music-2.6',
    });
  });

  it('happy path persists an audio file artifact by default', async () => {
    const result = await executeMusicGenerate(
      { prompt: '轻快的钢琴背景音乐' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'audio',
        sourceTool: 'music_generate',
        path: expect.stringContaining('/tmp/work/.code-agent/artifacts/music/generated-'),
        mimeType: 'audio/mpeg',
        metadata: {
          model: 'music-2.6',
          prompt: '轻快的钢琴背景音乐',
          mediaKind: 'audio',
        },
      });
      expect(result.meta?.model).toBe('music-2.6');
      expect(typeof result.meta?.costCny).toBe('number');
    }
    expect(writeFileSyncMock).toHaveBeenCalled();
    expect(generateMusicMock).toHaveBeenCalledTimes(1);
    const arg = generateMusicMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ baseUrl: 'https://api.minimax.chat/v1', apiKey: 'sk', modelName: 'music-2.6', prompt: '轻快的钢琴背景音乐' });
  });

  it('saves to file when output_path given', async () => {
    const result = await executeMusicGenerate(
      { prompt: 'jazz', lyrics: 'la la la', output_path: '/tmp/work/song.mp3' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.audioPath).toBe('/tmp/work/song.mp3');
      expect(result.meta?.artifact).toMatchObject({ kind: 'audio', path: '/tmp/work/song.mp3' });
    }
    const arg = generateMusicMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.lyrics).toBe('la la la');
  });

  it('resolver throws (missing key / unknown model) → error result, generateMusic NOT called', async () => {
    resolveMusicModelEndpointMock.mockImplementation(() => {
      throw new Error('音乐生成需要 MiniMax API Key。');
    });
    const result = await executeMusicGenerate(
      { prompt: 'pop' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('音乐生成失败');
    }
    expect(generateMusicMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects empty prompt → INVALID_ARGS, generateMusic NOT called', async () => {
    const result = await executeMusicGenerate({ prompt: '' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
    expect(generateMusicMock).not.toHaveBeenCalled();
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeMusicGenerate(
      { prompt: 'pop' },
      makeCtx(),
      async () => ({ allow: false, reason: 'no perm' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
    }
    expect(generateMusicMock).not.toHaveBeenCalled();
  });

  it('rejects pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeMusicGenerate(
      { prompt: 'pop' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
    expect(generateMusicMock).not.toHaveBeenCalled();
  });

  it('emits onProgress', async () => {
    const onProgress = vi.fn();
    await executeMusicGenerate({ prompt: 'pop' }, makeCtx(), allowAll, onProgress);
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'music_generate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
