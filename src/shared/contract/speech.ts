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
/**
 * 转写结果 → companion 结算载荷。
 *
 * **真实错误码必须带回手机**：静音/幻觉那一族（`SPEECH_SILENT_CODES`）在分片路径上不是失败，
 * 手机要靠这个码决定「静默跳过还是报错」。一律压成 `COMPANION_TRANSCRIPTION_FAILED` 的话，
 * 手机侧那条判据在生产里恒不成立——2026-09-13 第一版就是这么把整条修法接成死线的
 * （grok ai-review Important；当时集成测试是手工给网关塞 HALLUCINATION 才绿的，
 * 替身比真实写入点宽容）。抽成纯函数是为了让真实写入点和判据落在同一处。
 *
 * **住在 shared 而不是语音包里**：`src/host` / `src/web` 不许反向依赖
 * `src/host/services/speech`（`voiceHostReverseDependency` 架构门，语音是可插拔能力，
 * 宿主只能经注册端口够到它）。第一版放在语音包里，本机切片测试全绿、CI 那道门直接红。
 */
export function companionTranscriptionSettlement(
  result: Pick<SpeechTranscribeResult, 'success' | 'engine' | 'text' | 'code'>,
): { state: 'accepted' | 'rejected'; result: Record<string, unknown> } {
  if (result.success && result.engine === 'groq') {
    return { state: 'accepted', result: { text: result.text, engine: result.engine } };
  }
  const code = typeof result.code === 'string' ? result.code : 'COMPANION_TRANSCRIPTION_FAILED';
  // `silent` 是给手机的**结论**，不是让它自己再推一遍：分片路径上「这段没人说话」不算失败。
  return { state: 'rejected', result: { code, silent: isSilentCode(code) } };
}

export const SPEECH_EMPTY_RESULT_CODE = 'EMPTY_RESULT';
export const SPEECH_HALLUCINATION_CODE = 'HALLUCINATION';
/**
 * 静音码的知识**只活在本模块里**，对外只经 `companionTranscriptionSettlement` 那一个出口。
 * 早先把码表和判定式一并导出、让手机自己再判一次：两边各判各的，码一变就漂；
 * 而且手机端是另一个 workspace，dead-export 棘轮扫不到它，那三个导出在门里恒是死的。
 * 现在主机在结算时就把结论写进 `silent`，手机照着做即可——一处真源，一个消费方。
 */
const SILENT_CODES = [SPEECH_EMPTY_RESULT_CODE, SPEECH_HALLUCINATION_CODE] as const;
const isSilentCode = (code: unknown): boolean =>
  typeof code === 'string' && (SILENT_CODES as readonly string[]).includes(code);

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
