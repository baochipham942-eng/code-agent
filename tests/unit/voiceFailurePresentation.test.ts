import { describe, expect, it } from 'vitest';
import { zh } from '../../src/renderer/i18n/zh';
import {
  resolveVoiceErrorTitle,
  resolveVoiceMessage,
} from '../../src/renderer/components/features/voice/resolveVoiceMessage';

describe('语音上游错误展示', () => {
  it('主文案保持人话，上游原文只进入 title 详情', () => {
    const error = {
      code: 'UPSTREAM_ERROR' as const,
      message: 'upstream error',
      detail: 'Conversation already has an active response',
    };

    expect(resolveVoiceMessage(zh, error)).toBe('语音服务出错了，稍后再试');
    expect(resolveVoiceMessage(zh, error)).not.toContain(error.detail);
    expect(resolveVoiceErrorTitle(zh, error)).toBe(error.detail);
  });
});
