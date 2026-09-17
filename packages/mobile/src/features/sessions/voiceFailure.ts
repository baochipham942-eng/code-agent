import type { CompanionTranscriptionReadiness } from '../../../../../src/shared/companion/lanProtocol';
import type { messages } from '../../i18n';

/** 电脑没开转写 / 没配密钥：重试不会好，给「怎么开」。 */
const VOICE_SETUP_CODES = [
  'COMPANION_TRANSCRIPTION_UNAVAILABLE',
  'SPEECH_NO_CHANNEL',
  'DISABLED',
  'NOT_INITIALIZED',
  'UNAVAILABLE',
  'NO_CHANNEL',
] as const;

const VOICE_TOO_LARGE_CODES = ['AUDIO_TOO_LARGE'] as const;

/**
 * 这些码说的是「这条命令没走完」——没送达 / 通道被关 / 传输中断 / 被打断 / 结局不明：
 * 它们既不证明宿主能转写、也不证明不能，本地就绪态原地不动（ai-review Nit：
 * 网络断一下不该把三态追成 ready）。
 */
const VOICE_UNSETTLED_TRANSPORT_CODES = [
  'COMPANION_NETWORK_UNAVAILABLE',
  'COMPANION_CHANNEL_CLOSED',
  'COMPANION_TRANSFER_INTERRUPTED',
  'COMPANION_INTERRUPTED',
  'COMPANION_COMMAND_RECONCILING_TIMEOUT',
] as const;

/** 临时失败（网络 / 限流 / 超时 / 主机转写出错）：给重试。 */
const VOICE_RETRYABLE_TRANSCRIBE_CODES = [
  'COMPANION_TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_FAILED',
  'COMPANION_COMMAND_RECONCILING_TIMEOUT',
  'COMPANION_NETWORK_UNAVAILABLE',
  'COMPANION_CHANNEL_CLOSED',
  'COMPANION_TRANSFER_INTERRUPTED',
  'COMPANION_INTERRUPTED',
  'GROQ_RATE_LIMITED',
  'INVALID_ARGS',
  'AUDIO_TOO_SHORT',
  'LOCAL_TRANSCRIPTION_FAILED',
  'UNKNOWN',
] as const;

export type VoiceFailureKind =
  | 'setup'
  | 'too-large'
  | 'interrupted'
  | 'mic-unavailable'
  | 'denied'
  | 'busy'
  | 'retryable-transcribe'
  | 'retryable-record'
  | 'partial';

const inSet = (codes: readonly string[], reason: string | undefined): boolean =>
  typeof reason === 'string' && codes.includes(reason);

export function isVoiceSetupCode(reason: string | undefined): boolean {
  return inSet(VOICE_SETUP_CODES, reason);
}

export function isVoiceTooLargeCode(reason: string | undefined): boolean {
  return inSet(VOICE_TOO_LARGE_CODES, reason);
}

/**
 * 中继握手不刷新 binding.transcription：用 voice.transcribe 的真实回执把本地三态追上。
 * UNAVAILABLE / NO_CHANNEL 写成对应未就绪；DISABLED 不动（仍是「没开」但不是那两态）；
 * 网络/中断类不动（见 VOICE_UNSETTLED_TRANSPORT_CODES）；
 * 其余回执（含 accepted，或错误出自转写管线本身——引擎/限流/参数/音频）说明宿主已经能接转写，记 ready。
 */
export function transcriptionReadinessFromResult(
  accepted: boolean,
  code?: string,
): CompanionTranscriptionReadiness | null {
  if (code === 'COMPANION_TRANSCRIPTION_UNAVAILABLE' || code === 'UNAVAILABLE') return 'not-installed';
  if (code === 'SPEECH_NO_CHANNEL' || code === 'NO_CHANNEL') return 'no-key';
  if (code === 'DISABLED') return null;
  if (inSet(VOICE_UNSETTLED_TRANSPORT_CODES, code)) return null;
  if (accepted || code) return 'ready';
  return null;
}

export function classifyVoiceFailure(
  reason: string | undefined,
  stage?: 'record' | 'transcribe',
  partial?: boolean,
): VoiceFailureKind {
  if (reason === 'MICROPHONE_DENIED' || reason === 'MISSING_PERMISSION') return 'denied';
  if (reason === 'MICROPHONE_BUSY') return 'busy';
  if (reason === 'MICROPHONE_UNAVAILABLE') return 'mic-unavailable';
  if (reason === 'BACKGROUND_INTERRUPTED') return 'interrupted';
  if (isVoiceSetupCode(reason)) return 'setup';
  if (isVoiceTooLargeCode(reason)) return 'too-large';
  if (partial) return 'partial';
  if (stage === 'record') return 'retryable-record';
  return 'retryable-transcribe';
}

export function voiceFailureMessage(
  text: ReturnType<typeof messages>,
  kind: VoiceFailureKind,
): string {
  if (kind === 'denied') return text.microphoneDenied;
  if (kind === 'busy') return text.microphoneBusy;
  if (kind === 'mic-unavailable') return text.microphoneUnavailable;
  if (kind === 'interrupted') return text.voiceInterrupted;
  if (kind === 'setup') return text.voiceUnavailable;
  if (kind === 'too-large') return text.voiceTooLong;
  if (kind === 'partial') return text.voiceChunkDropped;
  if (kind === 'retryable-record') return text.voiceRecordFailed;
  return text.voiceTranscribeFailed;
}

export type VoiceFailureAction = { label: string; run(): void };

export function voiceFailureAction(
  text: ReturnType<typeof messages>,
  kind: VoiceFailureKind,
  act: {
    retry(): void;
    start(): void;
    openSettings?(): void;
    openVoiceSetup?(): void;
    micReleased?: boolean;
  },
): VoiceFailureAction | undefined {
  if (kind === 'denied') return act.openSettings ? { label: text.openMicrophoneSettings, run: act.openSettings } : undefined;
  if (kind === 'busy') return { label: act.micReleased ? text.continueRecording : text.microphoneBusyRetry, run: act.retry };
  if (kind === 'setup') return act.openVoiceSetup ? { label: text.voiceHowToEnable, run: act.openVoiceSetup } : undefined;
  if (kind === 'too-large') return undefined;
  if (kind === 'interrupted') return { label: text.voiceRerecord, run: act.start };
  return { label: text.retry, run: act.retry };
}
