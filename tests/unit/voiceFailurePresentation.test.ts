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

  it('存量通话配置回落提示走 i18n，并把最终模型与音色插入文案', () => {
    expect(resolveVoiceMessage(zh, {
      code: 'VOICE_CALL_SETTINGS_FALLBACK',
      message: 'qwen3.5-omni-flash-realtime / Tina',
    })).toBe(
      '之前选择的通话模型或音色已不再支持通话，已切换到 qwen3.5-omni-flash-realtime / Tina',
    );
  });
});

describe('语音派活失败文案出口', () => {
  it('任务槽超时按当前语言给出可行动说明，内部归因留在详情', () => {
    const marker = {
      code: 'TASK_SLOT_TIMEOUT' as const,
      laneKey: 'report',
      occupiedMs: 7_200_000,
      reason: 'terminal_event_timeout' as const,
    };
    const zhResult = describeWorkFailure('报告任务在 report lane 占用 2 小时后失联', {
      ...marker,
      locale: 'zh',
    });
    const enResult = describeWorkFailure('Report task lost its terminal event after 2 hours', {
      ...marker,
      locale: 'en',
    });

    expect(zhResult.screen).toContain('已释放它占用的任务队列');
    expect(zhResult.spoken).toContain('请重试');
    expect(zhResult.detail).toContain('report lane');
    expect(enResult.screen).toContain('queue slot was released');
    expect(enResult.spoken).toContain('Please retry');
    expect(enResult.detail).toContain('terminal event');
  });

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

  // 批 X5 ③：真机上失败卡详情是上游那句英文原文「You didn't provide an API key...」，
  // 用户既看不懂也不知道该去哪儿。
  it('缺 key / 鉴权失败给出去哪儿配的人话，屏幕点名模型、口播不念英文 id', () => {
    const raw = "OpenAI API (401): You didn't provide an API key.";
    const result = describeWorkFailure(raw, { code: 'MODEL_AUTH', provider: 'openai', model: 'gpt-4o' });

    expect(result.screen).toContain('API Key');
    expect(result.screen).toContain('设置 → 模型');
    expect(result.screen).toContain('openai/gpt-4o');
    expect(result.spoken).not.toContain('gpt-4o');
    expect(result.spoken).toContain('没有完成');
    // 上游原文只留详情，绝不进主文案或耳朵
    expect(result.screen).not.toContain('API key.');
    expect(result.spoken).not.toContain('API key.');
    expect(result.detail).toBe(raw);
  });

  it('认不出是哪个模型时文案退成泛指，不编一个模型名出来', () => {
    const result = describeWorkFailure('auth failed', { code: 'MODEL_AUTH' });

    expect(result.screen).toBe('执行任务的模型还没有配置 API Key，去 设置 → 模型 配置后重试');
  });

  // 判据必须是字段不是文本：同一句英文原文、没有结构化标记时一律走兜底
  // （deny-list 教训——按报错文本枚举的分类器换个供应商就静默失效）。
  it('只有英文原文、没有结构化标记时不认成缺 key', () => {
    const result = describeWorkFailure("You didn't provide an API key.");

    expect(result.screen).toBe('执行时出了问题，没有完成');
    expect(result.screen).not.toContain('API Key');
  });
});
