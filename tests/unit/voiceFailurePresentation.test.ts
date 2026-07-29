import { describe, expect, it } from 'vitest';
import { zh } from '../../src/renderer/i18n/zh';
import {
  resolveVoiceErrorTitle,
  resolveVoiceMessage,
} from '../../src/renderer/components/features/voice/resolveVoiceMessage';
import { describeWorkFailure } from '../../src/host/services/voice/workFailureDescription';

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

describe('语音派活失败文案出口', () => {
  it('未知异常不进入屏幕主文案或口播，只保留为详情', () => {
    const raw = 'Project Source trust identity changed: /Users/foo/secret/repo';
    const result = describeWorkFailure(raw);

    expect(result.screen).toBe('执行时出了问题，没有完成');
    expect(result.spoken).toContain('详情在屏幕上');
    expect(result.screen).not.toContain(raw);
    expect(result.spoken).not.toContain(raw);
    expect(result.detail).toBe(raw);
  });

  it('三种 Project Source trust 成因给三句人话和对应下一步', () => {
    const missing = describeWorkFailure('Project Source is missing: /repo/a', {
      code: 'PROJECT_SOURCE_TRUST',
      kind: 'source_missing',
    });
    const changed = describeWorkFailure('Project Source trust identity changed: /repo/a', {
      code: 'PROJECT_SOURCE_TRUST',
      kind: 'identity_changed',
    });
    const untrusted = describeWorkFailure('Project Source is not trusted: /repo/a', {
      code: 'PROJECT_SOURCE_TRUST',
      kind: 'not_trusted',
    });

    expect(missing.screen).toContain('重新选择位置');
    expect(changed.screen).toContain('重新确认授权');
    expect(untrusted.screen).toContain('完成授权');
    expect(new Set([missing.screen, changed.screen, untrusted.screen])).toHaveLength(3);
    for (const result of [missing, changed, untrusted]) {
      expect(result.spoken).not.toContain('/repo/a');
      expect(result.detail).toContain('/repo/a');
    }
  });
});
