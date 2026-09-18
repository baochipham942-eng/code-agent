import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH_INPUT_SETTINGS, type SpeechInputSettings } from '../../../../src/shared/contract';

const { execFileMock, getConfigServiceMock, transcribeWithWhisperCppMock, groqCreateMock, loggerMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getConfigServiceMock: vi.fn(),
  transcribeWithWhisperCppMock: vi.fn(),
  groqCreateMock: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: getConfigServiceMock,
}));

vi.mock('../../../../src/host/services/media/whisperCppTranscriber', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/host/services/media/whisperCppTranscriber')>(
    '../../../../src/host/services/media/whisperCppTranscriber',
  );
  return {
    ...actual,
    transcribeWithWhisperCpp: transcribeWithWhisperCppMock,
  };
});

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(function MockGroq() {
    return {
      audio: {
        transcriptions: {
          create: groqCreateMock,
        },
      },
    };
  }),
}));

import {
  LocalSpeechTranscriptionError,
} from '../../../../src/host/services/media/whisperCppTranscriber';
import {
  clearRetainedSpeechAudio,
  SpeechTranscriptionService,
} from '../../../../src/host/services/speech/speechTranscriptionService';
import { companionTranscriptionSettlement } from '../../../../src/shared/contract/speech';

function makeAudioData(size = 2048): string {
  return Buffer.alloc(size, 1).toString('base64');
}

function configureSpeech(settings: Partial<SpeechInputSettings> = {}) {
  const speech = {
    ...DEFAULT_SPEECH_INPUT_SETTINGS,
    ...settings,
  };
  getConfigServiceMock.mockReturnValue({
    getSettings: () => ({ speech }),
    getApiKey: (provider: string) => provider === 'groq' ? 'groq-key' : undefined,
  });
  return speech;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SpeechTranscriptionService', () => {
  beforeEach(() => {
    configureSpeech();
    execFileMock.mockImplementation((command: string, args: string[], options: unknown, callback?: (...args: unknown[]) => void) => {
      const cb = typeof options === 'function' ? options : callback;
      if (command === 'ffmpeg' && args.includes('-f') && args.includes('segment')) {
        const outputPattern = args[args.length - 1];
        const dir = path.dirname(outputPattern);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'chunk_000.wav'), Buffer.alloc(2048, 1));
        fs.writeFileSync(path.join(dir, 'chunk_001.wav'), Buffer.alloc(2048, 2));
      }
      cb?.(null, { stdout: '', stderr: '' });
      return {
        on: vi.fn(),
        kill: vi.fn(),
      };
    });
    transcribeWithWhisperCppMock.mockImplementation(async (options: {
      filePath: string;
      model?: string;
      language?: string;
    }) => ({
      text: '本地转写结果',
      sourcePath: options.filePath,
      model: options.model || 'ggml-large-v3-turbo.bin',
      modelPath: '/tmp/ggml-large-v3-turbo.bin',
      language: options.language || 'zh',
      outputFormat: 'text',
      translate: false,
      processingTimeMs: 123,
    }));
    groqCreateMock.mockResolvedValue('云端转写结果');
  });

  it('uses local whisper-cpp first with configured model, language, and threads', async () => {
    configureSpeech({
      mode: 'local-first',
      language: 'en',
      localModel: 'ggml-small.bin',
      threads: 6,
    });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result).toMatchObject({
      success: true,
      text: '本地转写结果',
      engine: 'local-whisper',
      model: 'ggml-small.bin',
      language: 'en',
    });
    expect(transcribeWithWhisperCppMock).toHaveBeenCalledWith(expect.objectContaining({
      language: 'en',
      model: 'ggml-small.bin',
      threads: 6,
    }));
    expect(groqCreateMock).not.toHaveBeenCalled();
  });

  it('splits long recordings into chunks and merges segment transcripts', async () => {
    configureSpeech({
      mode: 'local-first',
      language: 'zh',
      preserveAudioOnFailure: true,
    });
    transcribeWithWhisperCppMock.mockImplementation(async (options: {
      filePath: string;
      model?: string;
      language?: string;
    }) => {
      const basename = path.basename(options.filePath);
      return {
        text: basename.includes('000') ? '第一段' : '第二段',
        sourcePath: options.filePath,
        model: options.model || 'ggml-large-v3-turbo.bin',
        modelPath: '/tmp/ggml-large-v3-turbo.bin',
        language: options.language || 'zh',
        outputFormat: 'text',
        translate: false,
        processingTimeMs: basename.includes('000') ? 100 : 120,
      };
    });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
      durationSeconds: 121,
    });

    expect(result).toMatchObject({
      success: true,
      text: '第一段\n第二段',
      rawText: '第一段\n第二段',
      engine: 'local-whisper',
      language: 'zh',
      chunkCount: 2,
      durationMs: 220,
    });
    expect(result.segments).toEqual([
      expect.objectContaining({ index: 0, text: '第一段' }),
      expect.objectContaining({ index: 1, text: '第二段' }),
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-segment_time', '60']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    );
    expect(transcribeWithWhisperCppMock).toHaveBeenCalledTimes(2);
  });

  it('cloud-only 不按时长分段：121s 小文件不 spawn ffmpeg，整段直送 Groq', async () => {
    // 2026-09-12 台账真因：cloud-only 下按时长把 ffmpeg 拽进云链路，ffmpeg 一崩整条链死在
    // UNKNOWN。Groq 按文件大小收、不按时长，长而小的录音没有分段的理由。
    configureSpeech({ mode: 'cloud-only' });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/aac',
      source: 'composer',
      durationSeconds: 121,
    });

    expect(result).toMatchObject({ success: true, text: '云端转写结果', engine: 'groq' });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(groqCreateMock).toHaveBeenCalledTimes(1);
  });

  it('cloud-only 超过 24MB 仍分段，每片走 Groq（对齐 Groq 25MB 单文件上限）', async () => {
    configureSpeech({ mode: 'cloud-only' });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioBuffer: Buffer.alloc(24 * 1024 * 1024 + 1, 1),
      mimeType: 'audio/aac',
      source: 'composer',
    });

    expect(result).toMatchObject({ success: true, engine: 'groq', chunkCount: 2 });
    expect(transcribeWithWhisperCppMock).not.toHaveBeenCalled();
    expect(groqCreateMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 'segment']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    );
  });

  it('ffmpeg 分段失败回具名码 SEGMENT_FAILED（不是 UNKNOWN），stderr 落日志', async () => {
    configureSpeech({ mode: 'cloud-only', preserveAudioOnFailure: false });
    execFileMock.mockImplementation((command: string, _args: string[], options: unknown, callback?: (...args: unknown[]) => void) => {
      const cb = typeof options === 'function' ? options : callback;
      if (command === 'ffmpeg') {
        // ffmpeg 在、但跑砸：execFile 把 stderr 挂在 error 上，message 只带截断版本
        cb?.(Object.assign(new Error('Command failed: ffmpeg'), { stderr: 'Invalid data found when processing input' }));
        return { on: vi.fn(), kill: vi.fn() };
      }
      cb?.(null, { stdout: '', stderr: '' }); // which ffmpeg 成功 → 不是缺件，是跑砸
      return { on: vi.fn(), kill: vi.fn() };
    });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioBuffer: Buffer.alloc(24 * 1024 * 1024 + 1, 1),
      mimeType: 'audio/aac',
      source: 'composer',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SEGMENT_FAILED');
    expect(result.error).toContain('长语音分段失败');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'ffmpeg 长语音分段失败',
      expect.objectContaining({ stderr: expect.stringContaining('Invalid data found') }),
    );
  });

  it('returns raw text and applies optional transcript post-processing', async () => {
    configureSpeech({ postProcessingEnabled: true });
    transcribeWithWhisperCppMock.mockResolvedValueOnce({
      text: 'um hello  world',
      sourcePath: '/tmp/input.webm',
      model: 'ggml-large-v3-turbo.bin',
      modelPath: '/tmp/ggml-large-v3-turbo.bin',
      language: 'en',
      outputFormat: 'text',
      translate: false,
      processingTimeMs: 88,
    });
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result).toMatchObject({
      success: true,
      text: 'hello world',
      rawText: 'um hello  world',
      engine: 'local-whisper',
    });
  });

  it('only gates composer input with the desktop voice-input enabled switch', async () => {
    configureSpeech({ enabled: false });
    const service = new SpeechTranscriptionService();

    const composerResult = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });
    const voicePasteResult = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'voice-paste',
    });

    expect(composerResult).toMatchObject({
      success: false,
      code: 'DISABLED',
      recoverable: false,
    });
    expect(voicePasteResult).toMatchObject({
      success: true,
      text: '本地转写结果',
      engine: 'local-whisper',
    });
  });

  it('falls back to Groq when local-first local transcription fails', async () => {
    configureSpeech({ mode: 'local-first', language: 'auto' });
    transcribeWithWhisperCppMock.mockRejectedValue(
      new LocalSpeechTranscriptionError('NOT_INITIALIZED', 'whisper-cpp 未安装'),
    );
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result).toMatchObject({
      success: true,
      text: '云端转写结果',
      engine: 'groq',
      model: 'whisper-large-v3-turbo',
    });
    expect(groqCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'whisper-large-v3-turbo',
      response_format: 'text',
    }));
  });

  it('手机送来的 audio/aac 落盘成 .m4a——Groq 按扩展名收文件，.aac 会被 400 拒掉', async () => {
    // 2026-09-12 同字节差分实测：同一段音频命名 .m4a 转写成功，命名 .aac 得
    // 400 unsupported_audio_format（列表里没有 aac）。手机两端（iOS AVAudioRecorder /
    // Android MediaRecorder）报的都是 audio/aac，而字节本身就是 MP4 容器。
    configureSpeech({ mode: 'cloud-only' });
    const service = new SpeechTranscriptionService();

    await service.transcribe({ audioData: makeAudioData(), mimeType: 'audio/aac', source: 'composer' });

    const file = groqCreateMock.mock.calls.at(-1)?.[0]?.file as { path?: string } | undefined;
    expect(String(file?.path)).toMatch(/\.m4a$/);
  });

  it.each([
    ['audio/aac', '.m4a'],
    ['audio/mp4', '.m4a'],
    ['audio/wav', '.wav'],
    ['audio/webm', '.webm'],
  ])('%s 落盘扩展名是 %s', async (mimeType, extension) => {
    configureSpeech({ mode: 'cloud-only' });
    const service = new SpeechTranscriptionService();

    await service.transcribe({ audioData: makeAudioData(), mimeType, source: 'composer' });

    const file = groqCreateMock.mock.calls.at(-1)?.[0]?.file as { path?: string } | undefined;
    expect(String(file?.path).endsWith(extension)).toBe(true);
  });

  it.each([
    ['杨茜茜字幕志愿者'],
    ['字幕志愿者 李某某'],
    ['本视频字幕组出品'],
    ['字幕翻译：某某'],
    ['Subtitles by volunteer'],
    ['subtitle by someone'],
  ])('静音上吐出来的字幕尾巴「%s」要按家族拦住，不是逐条列举', async (text) => {
    // 2026-09-13 爸真机：环境只有鸟叫，输入框里冒出「杨茜茜字幕志愿者」。
    // 当时表里有「字幕由」「字幕制作」却没有「字幕志愿者」——逐条列举必漏，改成家族正则。
    configureSpeech({ mode: 'cloud-only' });
    groqCreateMock.mockResolvedValueOnce(text);
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({ audioData: makeAudioData(), mimeType: 'audio/aac', source: 'composer' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('HALLUCINATION');
  });

  it.each([
    ['帮我把这段视频的字幕对齐一下'],
    // 「翻译」是动词：光凭「字幕翻译」四个字拦，会把这句正常口令误杀（grok ai-review Nit）
    ['把这段字幕翻译成英文'],
    ['字幕组这个词怎么翻译比较好'],
  ])('正常说话里带「字幕」的口令「%s」不许误杀', async (text) => {
    configureSpeech({ mode: 'cloud-only' });
    groqCreateMock.mockResolvedValueOnce(text);
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({ audioData: makeAudioData(), mimeType: 'audio/aac', source: 'composer' });

    expect(result.success).toBe(true);
  });

  it('local-first 两条通道都断时报「没有可用通道」且不可重试（不把锅记在 Groq 头上）', async () => {
    // 真机现场：本机没装 whisper-cpp，又没配 Groq key —— 旧行为只报「未配置 Groq API Key」
    // 并给一个点了没用的「重试」，把用户指到错的地方。
    getConfigServiceMock.mockReturnValue({
      getSettings: () => ({ speech: { ...DEFAULT_SPEECH_INPUT_SETTINGS, mode: 'local-first' } }),
      getApiKey: () => undefined,
    });
    transcribeWithWhisperCppMock.mockRejectedValue(
      new LocalSpeechTranscriptionError('NOT_INITIALIZED', 'whisper-cpp 未安装'),
    );
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SPEECH_NO_CHANNEL');
    expect(result.recoverable).toBe(false);
    expect(result.error).toContain('whisper-cpp 未安装');
    expect(result.error).toContain('Groq API Key');
  });

  it('keeps the temp audio path on recoverable local-only failure when configured', async () => {
    configureSpeech({
      mode: 'local-only',
      preserveAudioOnFailure: true,
    });
    transcribeWithWhisperCppMock.mockRejectedValue(
      new LocalSpeechTranscriptionError('NOT_INITIALIZED', '模型文件不存在'),
    );
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result).toMatchObject({
      success: false,
      code: 'NOT_INITIALIZED',
      recoverable: true,
    });
    expect(result.audioPath).toBeTruthy();
    if (result.audioPath) {
      expect(result.audioPath).toContain('code-agent-speech-retained');
      expect(fs.existsSync(result.audioPath)).toBe(true);
      fs.unlinkSync(result.audioPath);
    }
  });

  it('can clear retained failure audio files', async () => {
    configureSpeech({
      mode: 'local-only',
      preserveAudioOnFailure: true,
    });
    transcribeWithWhisperCppMock.mockRejectedValue(
      new LocalSpeechTranscriptionError('NOT_INITIALIZED', '模型文件不存在'),
    );
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({
      audioData: makeAudioData(),
      mimeType: 'audio/webm',
      source: 'composer',
    });

    expect(result.audioPath).toBeTruthy();
    if (!result.audioPath) return;
    expect(fs.existsSync(result.audioPath)).toBe(true);

    const cleared = clearRetainedSpeechAudio();

    expect(cleared.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(result.audioPath)).toBe(false);
  });
});

describe('companionTranscriptionSettlement：真实错误码必须带回手机', () => {
  // 2026-09-13 grok ai-review Important：第一版把所有失败一律压成 COMPANION_TRANSCRIPTION_FAILED，
  // 手机侧那条「静音段不是失败」的判据在生产里恒不成立——整条修法接成了死线。
  // 当时集成测试是手工给网关塞 HALLUCINATION 才绿的：替身比真实写入点宽容。
  it.each([
    ['HALLUCINATION', true],
    ['EMPTY_RESULT', true],
    // 真失败不是「没人说话」：判成 silent 的话手机会静默吞掉，用户连重试入口都没有
    ['COMPANION_TRANSCRIPTION_UNAVAILABLE', false],
    ['COMPANION_TRANSCRIPTION_FAILED', false],
  ])('失败码 %s 原样带回，且 silent=%s（结论由主机给，手机不自己判）', (code, silent) => {
    const settlement = companionTranscriptionSettlement({ success: false, engine: 'groq', code } as never);
    expect(settlement.state).toBe('rejected');
    expect(settlement.result).toMatchObject({ code, silent });
  });

  it('没有码时才退到通用码，且不当成静音', () => {
    const settlement = companionTranscriptionSettlement({ success: false, engine: 'groq' } as never);
    expect(settlement.result).toMatchObject({ code: 'COMPANION_TRANSCRIPTION_FAILED', silent: false });
  });

  it('成功只认 groq 引擎，本地引擎的成功也按失败结算（既有口径不许放宽）', () => {
    expect(companionTranscriptionSettlement({ success: true, engine: 'groq', text: '你好' } as never))
      .toEqual({ state: 'accepted', result: { text: '你好', engine: 'groq' } });
    expect(companionTranscriptionSettlement({ success: true, engine: 'local-whisper', text: '你好' } as never).state)
      .toBe('rejected');
  });
});

describe('幻觉家族与收紧规则不许自相矛盾', () => {
  it.each([
    // 署名动词：是幻觉
    ['本片由天空字幕组压制', false],
    ['字幕组出品', false],
    ['由某某字幕组翻译', false],
    // 日常动词：不是幻觉，误杀的代价是用户这 4 秒真话无声消失
    ['字幕组翻译得挺好', true],
    ['这个字幕组翻译水平不错', true],
  ])('「%s」放行=%s', async (text, shouldPass) => {
    configureSpeech({ mode: 'cloud-only' });
    groqCreateMock.mockResolvedValueOnce(text);
    const service = new SpeechTranscriptionService();

    const result = await service.transcribe({ audioData: makeAudioData(), mimeType: 'audio/aac', source: 'composer' });

    expect(result.success).toBe(shouldPass);
  });
});
