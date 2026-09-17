import type { messages } from '../../i18n';

/** 电脑没开转写 / 没配密钥：重试不会好，给「怎么开」。 */
export const VOICE_SETUP_CODES = [
  'COMPANION_TRANSCRIPTION_UNAVAILABLE',
  'SPEECH_NO_CHANNEL',
  'DISABLED',
  'NOT_INITIALIZED',
  'UNAVAILABLE',
  'NO_CHANNEL',
] as const;

export const VOICE_TOO_LARGE_CODES = ['AUDIO_TOO_LARGE'] as const;

/** 临时失败（网络 / 限流 / 超时 / 主机转写出错）：给重试。 */
export const VOICE_RETRYABLE_TRANSCRIBE_CODES = [
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
