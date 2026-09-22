import { describe, expect, it } from 'vitest';
import {
  classifyVoiceFailure,
  isVoiceSetupCode,
  isVoiceTooLargeCode,
  transcriptionReadinessFromResult,
  voiceFailureAction,
  voiceFailureMessage,
} from '../../../packages/mobile/src/features/sessions/voiceFailure';
import { messages } from '../../../packages/mobile/src/i18n';

// 期望输入在测试侧钉死（独立于生产常量）：生产表里删掉任何一个码，这里必须跟红。
const VOICE_SETUP_CODES = [
  'COMPANION_TRANSCRIPTION_UNAVAILABLE',
  'SPEECH_NO_CHANNEL',
  'DISABLED',
  'NOT_INITIALIZED',
  'UNAVAILABLE',
  'NO_CHANNEL',
] as const;

const VOICE_TOO_LARGE_CODES = ['AUDIO_TOO_LARGE'] as const;

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

const text = messages('zh');
const act = {
  retry: () => {},
  start: () => {},
  openSettings: () => {},
  openVoiceSetup: () => {},
};

describe('转写失败文案与动作（逐错误码）', () => {
  it.each([...VOICE_SETUP_CODES])('%s → 电脑上还没开语音转写 + 怎么开，无重试', code => {
    expect(isVoiceSetupCode(code)).toBe(true);
    expect(classifyVoiceFailure(code, 'transcribe')).toBe('setup');
    expect(voiceFailureMessage(text, 'setup')).toBe('电脑上还没开语音转写');
    expect(voiceFailureAction(text, 'setup', act)?.label).toBe('怎么开');
  });

  it.each([...VOICE_TOO_LARGE_CODES])('%s → 这段太长了，分成几段录，无重试', code => {
    expect(isVoiceTooLargeCode(code)).toBe(true);
    expect(classifyVoiceFailure(code, 'transcribe')).toBe('too-large');
    expect(voiceFailureMessage(text, 'too-large')).toBe('这段太长了，分成几段录');
    expect(voiceFailureAction(text, 'too-large', act)).toBeUndefined();
  });

  it.each([...VOICE_RETRYABLE_TRANSCRIBE_CODES])('%s → 这段没转成文字 + 重试', code => {
    expect(classifyVoiceFailure(code, 'transcribe')).toBe('retryable-transcribe');
    expect(voiceFailureMessage(text, 'retryable-transcribe')).toBe('这段没转成文字');
    expect(voiceFailureAction(text, 'retryable-transcribe', act)?.label).toBe('重试');
  });

  // N-MOBILE-BG-RECORDING：BACKGROUND_INTERRUPTED 的唯一生产者（visibilitychange 自杀）已删，
  // 分类与文案一并收掉——后台继续录音不是失败，不该再有一条「切到后台，录音停了」的分支。

  it('voice.transcribe 回执把本地就绪态追上', () => {
    expect(transcriptionReadinessFromResult(true)).toBe('ready');
    expect(transcriptionReadinessFromResult(false, 'COMPANION_TRANSCRIPTION_FAILED')).toBe('ready');
    expect(transcriptionReadinessFromResult(false, 'COMPANION_TRANSCRIPTION_UNAVAILABLE')).toBe('not-installed');
    expect(transcriptionReadinessFromResult(false, 'UNAVAILABLE')).toBe('not-installed');
    expect(transcriptionReadinessFromResult(false, 'SPEECH_NO_CHANNEL')).toBe('no-key');
    expect(transcriptionReadinessFromResult(false, 'NO_CHANNEL')).toBe('no-key');
    expect(transcriptionReadinessFromResult(false, 'DISABLED')).toBeNull();
  });

  // ai-review PR#1919 Nit：网络断开 / 中断类错误不证明宿主能转写，就绪态原地不动（null）。
  it('网络/中断类回执不改本地就绪态', () => {
    expect(transcriptionReadinessFromResult(false, 'COMPANION_NETWORK_UNAVAILABLE')).toBeNull();
    expect(transcriptionReadinessFromResult(false, 'COMPANION_CHANNEL_CLOSED')).toBeNull();
    expect(transcriptionReadinessFromResult(false, 'COMPANION_TRANSFER_INTERRUPTED')).toBeNull();
    expect(transcriptionReadinessFromResult(false, 'COMPANION_INTERRUPTED')).toBeNull();
    expect(transcriptionReadinessFromResult(false, 'COMPANION_COMMAND_RECONCILING_TIMEOUT')).toBeNull();
    // 转写管线自己的错误（引擎/限流/音频）仍算「宿主能接转写」——那是跑过之后的失败，不是没配上
    expect(transcriptionReadinessFromResult(false, 'GROQ_RATE_LIMITED')).toBe('ready');
    expect(transcriptionReadinessFromResult(false, 'AUDIO_TOO_SHORT')).toBe('ready');
  });

  it('无输入与被占用分开', () => {
    expect(classifyVoiceFailure('MICROPHONE_UNAVAILABLE', 'record')).toBe('mic-unavailable');
    expect(voiceFailureMessage(text, 'mic-unavailable')).toBe('麦克风暂时用不了');
    expect(voiceFailureAction(text, 'mic-unavailable', act)?.label).toBe('重试');
    expect(classifyVoiceFailure('MICROPHONE_BUSY', 'record')).toBe('busy');
    expect(voiceFailureMessage(text, 'busy')).toBe('麦克风被占用，通话结束后再录');
    expect(voiceFailureAction(text, 'busy', act)?.label).toBe('结束后再试');
  });
});
