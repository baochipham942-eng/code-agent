// ============================================================================
// Speech input and transcription contracts
// ============================================================================

export type SpeechTranscriptionMode = 'stream' | 'local-first' | 'local-only' | 'cloud-only';

export type SpeechCloudProvider = 'groq';

/**
 * 转写结果 → companion 结算载荷。**这是静音码对外的唯一出口。**
 *
 * 「这段音频里没人说话」——`EMPTY_RESULT` 是转出来一片空白，`HALLUCINATION` 是转出了
 * whisper 在静音上惯出来的语料残渣（「请不吝点赞」「字幕由…」）。整段录音时把它们当失败是对的
 *（整段没说话就该提示重说）；分片伪流式下判据反过来——4 秒一段，句子之间的停顿段本来就该是空的，
 * 静音是**常态**（2026-09-13 真机：30 段命中 13 段，43%），当失败就是每隔几秒报一次错。
 *
 * 所以结算把结论直接写进 `result.silent`：**主机判一次，手机照做**。
 * 不把码表导出去让手机再判一遍——两边各判各的，码一变就漂
 *（而且手机是另一个 workspace，dead-export 棘轮扫不到它，导出去的码表在门里恒是死的）。
 * 真实错误码仍原样带回 `result.code` 供显示；一律压成 `COMPANION_TRANSCRIPTION_FAILED` 的话，
 * 手机侧整条判据在生产里恒不成立——第一版就是这么接成死线的（grok ai-review Important；
 * 当时集成测试是手工给网关塞 HALLUCINATION 才绿的，替身比真实写入点宽容）。
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
/** Groq/whisper verbose_json：高于此视为无语音。 */
const SPEECH_NO_SPEECH_PROB_MAX = 0.6;
/** Groq/whisper verbose_json：低于此视为不可信（常是幻觉）。 */
const SPEECH_AVG_LOGPROB_MIN = -1.0;

export type SpeechAsrSegment = {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
};

function isVoicedSegment(segment: SpeechAsrSegment): boolean {
  const noSpeechProb = segment.no_speech_prob;
  const avgLogprob = segment.avg_logprob;
  const hasNoSpeech = typeof noSpeechProb === 'number';
  const hasLogprob = typeof avgLogprob === 'number';
  const noSpeech = hasNoSpeech && noSpeechProb > SPEECH_NO_SPEECH_PROB_MAX;
  const lowConf = hasLogprob && avgLogprob < SPEECH_AVG_LOGPROB_MIN;
  // Whisper 静音是「无语音概率高 *且* 平均 logprob 差」才跳过：高 no_speech_prob
  // 但 logprob 好的分段是正常口令，丢掉会让手机把整句当静音吞掉。
  if (hasNoSpeech && hasLogprob) return !(noSpeech && lowConf);
  if (hasNoSpeech) return !noSpeech;
  return true;
}

/**
 * 按分段置信度 / 无语音概率丢掉远场残渣。没有分段时（本地 whisper 或纯文本回包）原样保留，
 * 后面的幻觉词表仍会拦字幕尾巴。
 */
export function keepVoicedTranscript(rawText: string, segments?: SpeechAsrSegment[]): string {
  if (!segments?.length) return rawText.trim();
  return segments
    .filter(isVoicedSegment)
    .map(segment => (typeof segment.text === 'string' ? segment.text : ''))
    .join('')
    .trim();
}

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
