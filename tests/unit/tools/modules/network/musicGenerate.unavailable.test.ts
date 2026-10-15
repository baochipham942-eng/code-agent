// ============================================================================
// music_generate 服务不可用出路 tests — N-MEDIA-GEN-MUSIC-FALLBACK
//
// 内置默认模型（无冒号）撞 HTTP 410（付费音乐 API 2026-08-20 起对新账户关闭）或
// 缺 MiniMax key 时：MUSIC_SERVICE_UNAVAILABLE（meta.alternatives 列桥接音乐模型）
// / MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE，error 保持 0/1 saved + per_request 合同
// 且明说不可重试；generateMusic 恰好一次（410）/ 零次（缺 key），无重试。
// 非 410 HTTP 错误与桥接模型路径不受影响（保持 MUSIC_GENERATION_FAILED）。
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

// 部分模块 mock（importActual 透传骨架）：generateMusic/resolveMusicModelEndpoint 可控，
// MusicHttpError 保持真实类——被测模块的 instanceof 判的是同一个类对象
//（vi.hoisted 返回值里的 class 声明会被本版 vitest 丢成 undefined，不能走那条路）。
const musicService = vi.hoisted(() => ({
  generateMusic: vi.fn(),
  resolveMusicModelEndpoint: vi.fn(),
}));

vi.mock('../../../../../src/host/services/media/musicGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/services/media/musicGenerationService')>();
  return {
    ...actual,
    generateMusic: musicService.generateMusic,
    resolveMusicModelEndpoint: musicService.resolveMusicModelEndpoint,
  };
});

const imageService = vi.hoisted(() => ({
  getMinimaxApiKey: vi.fn(),
}));

// settings 桥接模型派生走真实 deriveBridgedVisualModels，只 mock 读 settings 的入口。
const settingsState = vi.hoisted(() => ({ settings: null as unknown }));
const getConfigServiceMock = vi.hoisted(() => vi.fn(() => ({
  onSettingsUpdated: vi.fn(),
  getSettings: () => settingsState.settings,
})));

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));
vi.mock('../../../../../src/host/services/media/imageGenerationService', () => imageService);

import { executeMusicGenerate } from '../../../../../src/host/plugins/builtin/musicGeneration/musicGenerate';
import { MusicHttpError } from '../../../../../src/host/services/media/musicGenerationService';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ctx(workspace: string, controller = new AbortController()): ToolContext {
  return {
    sessionId: 'unavailable-test',
    workingDir: workspace,
    abortSignal: controller.signal,
    logger: logger(),
    emit: vi.fn(),
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

// 完整 provider 配置：deriveBridgedVisualModels 需 apiKeyConfigured + capabilities
// 才派生条目（同 resolveMusicEndpoint.test.ts 夹具，派生 custom-x:some-music）。
const BRIDGED_SETTINGS = {
  models: {
    providers: {
      'custom-x': {
        displayName: 'X', baseUrl: 'https://bridge.example.com/v1', apiKeyConfigured: true, enabled: true,
        models: {
          'some-music': { capabilities: ['musicGen'], enabled: true },
          'chat-model': { capabilities: ['general'], enabled: true },
        },
      },
    },
  },
} as never;

describe('music_generate default service unavailable', () => {
  let workspace: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'music-unavailable-'));
    settingsState.settings = null;
    imageService.getMinimaxApiKey.mockReset().mockReturnValue('test-minimax-key');
    musicService.resolveMusicModelEndpoint.mockReset().mockReturnValue({
      baseUrl: 'https://api.minimax.chat/v1',
      apiKey: 'sk',
      modelName: 'music-2.6',
    });
    musicService.generateMusic.mockReset().mockRejectedValue(new MusicHttpError(410));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function artifactDirUntouched(): boolean {
    return !fs.existsSync(path.join(workspace, '.code-agent'));
  }

  it('410 with a bridged music model configured → MUSIC_SERVICE_UNAVAILABLE listing it, engine called exactly once', async () => {
    settingsState.settings = BRIDGED_SETTINGS;
    const result = await executeMusicGenerate({ prompt: '轻快的钢琴背景音乐' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_SERVICE_UNAVAILABLE');
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('音乐生成失败 HTTP 410');
      expect(result.error).toContain('The default MiniMax music service is unavailable (HTTP 410). Do not retry.');
      expect(result.error).toContain('Configured music models you can pass as `model`: custom-x:some-music.');
    }
    expect(result.meta?.alternatives).toBe('custom-x:some-music');
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([{ index: 1, status: 'failed', error: '音乐生成失败 HTTP 410' }]);
    expect(result.meta?.artifacts).toEqual([]);
    // 不重试：引擎恰好一次，无真实网络、无写盘
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(artifactDirUntouched()).toBe(true);
  });

  it('410 with no bridged music model → MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE telling the model to inform the user', async () => {
    const result = await executeMusicGenerate({ prompt: '一首短曲' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE');
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('Do not retry.');
      expect(result.error).toContain('No other music model is configured; tell the user music generation is currently unavailable.');
    }
    expect(result.meta?.alternatives).toBeUndefined();
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(artifactDirUntouched()).toBe(true);
  });

  it('missing MiniMax key with a bridged music model → MUSIC_SERVICE_UNAVAILABLE before any endpoint resolution or paid call', async () => {
    settingsState.settings = BRIDGED_SETTINGS;
    imageService.getMinimaxApiKey.mockReturnValue(undefined);
    const result = await executeMusicGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_SERVICE_UNAVAILABLE');
      expect(result.error).toContain('The default MiniMax music service is unavailable (no key). Do not retry.');
      expect(result.error).toContain('MiniMax API key is missing');
      expect(result.error).toContain('custom-x:some-music');
    }
    expect(result.meta?.alternatives).toBe('custom-x:some-music');
    expect(musicService.resolveMusicModelEndpoint).not.toHaveBeenCalled();
    expect(musicService.generateMusic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(artifactDirUntouched()).toBe(true);
  });

  it('missing MiniMax key with no bridged music model → MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE, zero paid calls', async () => {
    imageService.getMinimaxApiKey.mockReturnValue(undefined);
    const result = await executeMusicGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE');
      expect(result.error).toContain('(no key). Do not retry.');
      expect(result.error).toContain('No other music model is configured');
    }
    expect(musicService.resolveMusicModelEndpoint).not.toHaveBeenCalled();
    expect(musicService.generateMusic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(artifactDirUntouched()).toBe(true);
  });

  it('non-410 HTTP error keeps MUSIC_GENERATION_FAILED even when alternatives exist', async () => {
    settingsState.settings = BRIDGED_SETTINGS;
    musicService.generateMusic.mockRejectedValue(new MusicHttpError(500));
    const result = await executeMusicGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_GENERATION_FAILED');
      expect(result.error).toContain('音乐生成失败 HTTP 500');
    }
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
  });

  it('410 on a bridged provider:model keeps MUSIC_GENERATION_FAILED (fallback only for the built-in default)', async () => {
    settingsState.settings = BRIDGED_SETTINGS;
    const result = await executeMusicGenerate(
      { prompt: 'ok', model: 'custom-x:some-music' },
      ctx(workspace),
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_GENERATION_FAILED');
      expect(result.error).not.toContain('MUSIC_SERVICE_UNAVAILABLE');
    }
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
  });
});
