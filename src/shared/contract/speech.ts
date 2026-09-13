// ============================================================================
// Speech input and transcription contracts
// ============================================================================

export type SpeechTranscriptionMode = 'stream' | 'local-first' | 'local-only' | 'cloud-only';

export type SpeechCloudProvider = 'groq';

/**
 * 「这段音频里没人说话」——**不是失败**。
 *
 * `EMPTY_RESULT` 是转出来一片空白，`HALLUCINATION` 是转出了 whisper 在静音上惯出来的
 * 那些语料残渣（「请不吝点赞」「字幕由…」）。整段录音时把它们当失败是对的：整段没说话，
 * 就该提示用户重说。分片伪流式下判据反过来——4 秒一段，句子之间的停顿段本来就该是空的，
 * 静音是**常态**（2026-09-13 真机：30 段命中 13 段，43%），当成失败就是每隔几秒报一次错。
 *
 * 手机与 Host 共用这一份表：Host 产码、手机据此判「跳过还是报错」，分成两份必然漂。
 */
export const SPEECH_EMPTY_RESULT_CODE = 'EMPTY_RESULT';
export const SPEECH_HALLUCINATION_CODE = 'HALLUCINATION';
export const SPEECH_SILENT_CODES = [SPEECH_EMPTY_RESULT_CODE, SPEECH_HALLUCINATION_CODE] as const;
export type SpeechSilentCode = (typeof SPEECH_SILENT_CODES)[number];
export const isSpeechSilentCode = (code: unknown): code is SpeechSilentCode =>
  typeof code === 'string' && (SPEECH_SILENT_CODES as readonly string[]).includes(code);

export type SpeechTranscriptionEngine = 'local-whisper' | 'groq';

export const VOICE_INPUT_SETTINGS_UPDATED_EVENT = 'voice-input-settings-updated';

export interface SpeechInputSettings {
  enabled: boolean;
  mode: SpeechTranscriptionMode;
  language: string;
  localModel: string;
  threads: number;
  maxDurationSeconds: number;
  preserveAudioOnFailure: boolean;
  cloudProvider: SpeechCloudProvider;
  postProcessingEnabled: boolean;
  shortcut?: string;
}

export const DEFAULT_SPEECH_INPUT_SETTINGS: SpeechInputSettings = {
  enabled: true,
  mode: 'stream',
  language: 'zh',
  localModel: 'ggml-large-v3-turbo.bin',
  threads: 4,
  maxDurationSeconds: 60,
  preserveAudioOnFailure: true,
  cloudProvider: 'groq',
  postProcessingEnabled: false,
  shortcut: '',
};

export interface SpeechTranscribeOptions {
  mode?: SpeechTranscriptionMode;
  language?: string;
  model?: string;
  threads?: number;
  source?: 'composer' | 'tool' | 'voice-paste' | 'web';
  keepAudioOnFailure?: boolean;
  durationSeconds?: number;
}

export interface SpeechTranscriptionSegment {
  index: number;
  text: string;
  rawText?: string;
  engine?: SpeechTranscriptionEngine;
  language?: string;
  model?: string;
  durationMs?: number;
}

export interface SpeechRetainedAudioClearResult {
  deletedFiles: number;
}

export interface SpeechTranscribeResult {
  success: boolean;
  text?: string;
  rawText?: string;
  error?: string;
  code?: string;
  recoverable?: boolean;
  hallucination?: boolean;
  engine?: SpeechTranscriptionEngine;
  language?: string;
  model?: string;
  durationMs?: number;
  audioDurationSeconds?: number;
  audioPath?: string;
  chunkCount?: number;
  segments?: SpeechTranscriptionSegment[];
}
