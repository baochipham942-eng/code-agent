import { describe, expect, it } from 'vitest';
import {
  classifyVoiceFailure,
  isVoiceSetupCode,
  isVoiceTooLargeCode,
  voiceFailureAction,
  voiceFailureMessage,
  VOICE_RETRYABLE_TRANSCRIBE_CODES,
  VOICE_SETUP_CODES,
  VOICE_TOO_LARGE_CODES,
} from '../../../packages/mobile/src/features/sessions/voiceFailure';
import { messages } from '../../../packages/mobile/src/i18n';

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

  it('切后台 → 切到后台，录音停了 + 重新录', () => {
    expect(classifyVoiceFailure('BACKGROUND_INTERRUPTED', 'record')).toBe('interrupted');
    expect(voiceFailureMessage(text, 'interrupted')).toBe('切到后台，录音停了');
    expect(voiceFailureAction(text, 'interrupted', act)?.label).toBe('重新录');
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
