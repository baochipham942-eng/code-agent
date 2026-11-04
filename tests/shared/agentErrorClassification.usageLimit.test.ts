import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../../src/shared/utils/agentErrorClassification';

const REAL_BODY = '已达到 5 小时的使用上限。您的限额将在 2026-11-03 17:34:10 重置。';

describe('classifyAgentError · usage_limit', () => {
  it('③ failure 标记 → usage_limit，带窗口词与 resetAt，模型/供应商来自标记', () => {
    const result = classifyAgentError({
      message: REAL_BODY,
      code: 'RUN_FAILED',
      failure: { code: 'MODEL_USAGE_LIMIT', provider: 'zhipu', model: 'glm-5.3', windowText: '5 小时', resetAt: '2026-11-03T09:34:10.000Z' },
    });
    expect(result).toMatchObject({
      category: 'usage_limit',
      httpStatus: 429,
      usageWindowText: '5 小时',
      resetAt: '2026-11-03T09:34:10.000Z',
      provider: 'zhipu',
      modelId: 'glm-5.3',
    });
  });

  it('④ 元数据经持久化（JSON 往返）后 resetAt 仍在，会话重开卡片还能显示', () => {
    const meta = classifyAgentError({ message: REAL_BODY, failure: { code: 'MODEL_USAGE_LIMIT', resetAt: '2026-11-03T09:34:10.000Z' } });
    const reloaded = JSON.parse(JSON.stringify(meta));
    expect(reloaded.category).toBe('usage_limit');
    expect(reloaded.resetAt).toBe('2026-11-03T09:34:10.000Z');
  });

  it('没有标记的中文正文仍是 generic（不靠 renderer 正则猜）', () => {
    expect(classifyAgentError({ message: REAL_BODY })?.category).toBe('generic');
  });

  it('⑤ 普通 429 仍是 rate_limited', () => {
    expect(classifyAgentError({ message: 'Rate limit reached, 429 Too Many Requests' })?.category).toBe('rate_limited');
    expect(classifyAgentError({ message: 'Too many requests', httpStatus: 429 })?.category).toBe('rate_limited');
  });
});
