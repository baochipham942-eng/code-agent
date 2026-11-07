import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../../src/shared/utils/agentErrorClassification';
import { detectUsageLimit } from '../../src/shared/utils/usageLimitDetection';

const REAL_BODY = '已达到 5 小时的使用上限。您的限额将在 2026-11-03 17:34:10 重置。';

// 复刻 runFinalizer.ts:405-425 的挂载链路：detectUsageLimit 命中才挂 failure 标记，
// classifyAgentError 只认标记（不自己猜正文）——两端在同一测试里对齐。
function runFailureEvent(message: string, error: unknown = new Error(message)) {
  const info = detectUsageLimit(error);
  return { message, code: 'RUN_FAILED', ...(info ? { failure: { code: 'MODEL_USAGE_LIMIT', ...info } } : {}) };
}

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

  it('⑥ 裸数字 1308/1310（端口 / token 数 / 毫秒）不出 usage-limit 卡：按文本走 network/generic', () => {
    expect(classifyAgentError(runFailureEvent('connect ECONNREFUSED 127.0.0.1:1308'))?.category).toBe('network');
    expect(classifyAgentError(runFailureEvent('used 1308 tokens this turn'))?.category).toBe('generic');
    expect(classifyAgentError(runFailureEvent('request timed out after 1310 ms'))?.category).toBe('network');
  });

  it('⑦ 结构化错误码与真机 429 正文走同一挂载链路仍是 usage_limit，重置时间不丢', () => {
    const event = runFailureEvent(REAL_BODY, { statusCode: 429, message: REAL_BODY });
    expect(classifyAgentError(event)).toMatchObject({
      category: 'usage_limit',
      usageWindowText: '5 小时',
      resetAt: '2026-11-03T09:34:10.000Z',
    });
    expect(classifyAgentError(runFailureEvent('请求失败，错误码 1308，请稍后重试'))?.category).toBe('usage_limit');
  });
});

describe('detectUsageLimit · 错误码只认结构化形态', () => {
  it('① 裸数字 1308/1310 不触发（端口 / token 数 / 毫秒，无用量上限措辞）', () => {
    expect(detectUsageLimit('connect ECONNREFUSED 127.0.0.1:1308')).toBeUndefined();
    expect(detectUsageLimit(new Error('used 1308 tokens this turn'))).toBeUndefined();
    expect(detectUsageLimit('request timed out after 1310 ms')).toBeUndefined();
  });

  it('② 结构化形态仍触发：JSON code 字段 / code: 前缀 / 中文「错误码」，真机正文走 429+措辞', () => {
    expect(detectUsageLimit('{"error":{"code":"1308","message":"..."}}')).toEqual({});
    expect(detectUsageLimit('AI_APICallError: code: 1310, retry after window reset')).toEqual({});
    expect(detectUsageLimit('请求失败，错误码 1310，请稍后重试')).toEqual({});
    expect(detectUsageLimit({ statusCode: 429, message: REAL_BODY })).toEqual({
      windowText: '5 小时',
      resetAt: '2026-11-03T09:34:10.000Z',
    });
  });
});
