// ============================================================================
// Speech input and transcription contracts
// ============================================================================

export type SpeechTranscriptionMode = 'local-first' | 'local-only' | 'cloud-only';

export type SpeechCloudProvider = 'groq';

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
  mode: 'local-first',
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
