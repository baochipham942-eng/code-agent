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

vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: getConfigServiceMock,
}));

vi.mock('../../../../src/main/services/speech/whisperCppTranscriber', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/main/services/speech/whisperCppTranscriber')>(
    '../../../../src/main/services/speech/whisperCppTranscriber',
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
} from '../../../../src/main/services/speech/whisperCppTranscriber';
import {
  clearRetainedSpeechAudio,
  SpeechTranscriptionService,
} from '../../../../src/main/services/speech/speechTranscriptionService';

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
