import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH_INPUT_SETTINGS, type SpeechInputSettings } from '../../../../src/shared/contract';

const { execFileMock, getConfigServiceMock, transcribeWithWhisperCppMock, groqCreateMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getConfigServiceMock: vi.fn(),
  transcribeWithWhisperCppMock: vi.fn(),
  groqCreateMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
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
  companionTranscriptionSettlement,
  SpeechTranscriptionService,
} from '../../../../src/host/services/speech/speechTranscriptionService';

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
    ['HALLUCINATION'],
    ['EMPTY_RESULT'],
    ['COMPANION_TRANSCRIPTION_UNAVAILABLE'],
  ])('失败码 %s 原样带回，不许压成通用码', (code) => {
    const settlement = companionTranscriptionSettlement({ success: false, engine: 'groq', code } as never);
    expect(settlement.state).toBe('rejected');
    expect(settlement.result.code).toBe(code);
  });

  it('没有码时才退到通用码', () => {
    const settlement = companionTranscriptionSettlement({ success: false, engine: 'groq' } as never);
    expect(settlement.result.code).toBe('COMPANION_TRANSCRIPTION_FAILED');
  });

  it('成功只认 groq 引擎，本地引擎的成功也按失败结算（既有口径不许放宽）', () => {
    expect(companionTranscriptionSettlement({ success: true, engine: 'groq', text: '你好' } as never))
      .toEqual({ state: 'accepted', result: { text: '你好', engine: 'groq' } });
    expect(companionTranscriptionSettlement({ success: true, engine: 'local-whisper', text: '你好' } as never).state)
      .toBe('rejected');
  });
});
