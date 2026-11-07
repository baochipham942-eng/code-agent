import { afterEach, describe, expect, it } from 'vitest';
import { getModelUsageLimitFailureMarker, classifyError } from '../../../src/host/model/errorClassifier';

// 真机正文（GLM Coding Plan 首次命中，realrun22 quota-first-hit）：无 1308 / 429 / rate limit 字样，时间戳无时区 = 北京时间。
const REAL_BODY = '已达到 5 小时的使用上限。您的限额将在 2026-11-03 17:34:10 重置。';
const RESET_INSTANT = '2026-11-03T09:34:10.000Z';

function apiCallError(over: Record<string, unknown>): Error {
  return Object.assign(new Error('Too Many Requests'), { name: 'AI_APICallError', ...over });
}

describe('getModelUsageLimitFailureMarker', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  });

  it('① 真机中文 429 正文认成 MODEL_USAGE_LIMIT（普通分类器仍只会说 rate_limit）', () => {
    const error = apiCallError({ statusCode: 429, responseBody: REAL_BODY, provider: 'zhipu', model: 'glm-5.3' });
    expect(classifyError(error)).toBe('rate_limit');
    expect(getModelUsageLimitFailureMarker(error)).toEqual({
      code: 'MODEL_USAGE_LIMIT',
      provider: 'zhipu',
      model: 'glm-5.3',
      windowText: '5 小时',
      resetAt: RESET_INSTANT,
    });
  });

  it('② 无时区时间戳按北京时间解析，TZ=America/Los_Angeles 与 Asia/Shanghai 得到同一时刻', () => {
    const error = apiCallError({ statusCode: 429, responseBody: REAL_BODY });
    const instants = ['America/Los_Angeles', 'Asia/Shanghai'].map((tz) => {
      process.env.TZ = tz;
      return getModelUsageLimitFailureMarker(error)?.resetAt;
    });
    expect(instants).toEqual([RESET_INSTANT, RESET_INSTANT]);
  });

  it('沿 cause 链上溯；「将于」措辞与带时区的时间原样保留', () => {
    const wrapped = new Error('run failed', {
      cause: apiCallError({ statusCode: 429, responseBody: '已达到 5 小时的使用上限。您的限额将于 2026-11-03T20:00:00Z 重置。', provider: 'zhipu' }),
    });
    expect(getModelUsageLimitFailureMarker(wrapped)).toMatchObject({ resetAt: '2026-11-03T20:00:00.000Z', provider: 'zhipu' });
  });

  it('1308 错误码变体（无 429 状态）也认', () => {
    const error = new Error('{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-11-03 17:34:10 重置。"}}');
    expect(getModelUsageLimitFailureMarker(error)).toMatchObject({ code: 'MODEL_USAGE_LIMIT', windowText: '5 小时', resetAt: RESET_INSTANT });
  });

  it('⑥ 结构化错误码形态仍认：`code: 1310` 与中文「错误码 1308」', () => {
    expect(getModelUsageLimitFailureMarker(apiCallError({ statusCode: 400, responseBody: '{"error":{"code":1310,"message":"quota window exhausted"}}' })))
      .toMatchObject({ code: 'MODEL_USAGE_LIMIT' });
    expect(getModelUsageLimitFailureMarker(new Error('AI_APICallError: code: 1310, retry after window reset')))
      .toMatchObject({ code: 'MODEL_USAGE_LIMIT' });
    expect(getModelUsageLimitFailureMarker(new Error('请求失败，错误码 1308，请稍后重试')))
      .toMatchObject({ code: 'MODEL_USAGE_LIMIT' });
  });

  it('⑦ 裸数字 1308/1310 不算错误码：端口 / token 数 / 毫秒文本不产生 usage-limit 标记', () => {
    expect(getModelUsageLimitFailureMarker(new Error('connect ECONNREFUSED 127.0.0.1:1308'))).toBeUndefined();
    expect(getModelUsageLimitFailureMarker(apiCallError({ statusCode: 500, responseBody: 'used 1308 tokens this turn' }))).toBeUndefined();
    expect(getModelUsageLimitFailureMarker(new Error('request timed out after 1310 ms'))).toBeUndefined();
  });

  it('② 解析不出时间时仍是 usage limit，只是不带 resetAt', () => {
    const error = apiCallError({ statusCode: 429, responseBody: '{"error":{"code":"1308","message":"已达到使用上限"}}' });
    const marker = getModelUsageLimitFailureMarker(error);
    expect(marker?.code).toBe('MODEL_USAGE_LIMIT');
    expect(marker?.resetAt).toBeUndefined();
  });

  it('⑤ 普通 429（无用量上限措辞）不算 usage limit', () => {
    expect(getModelUsageLimitFailureMarker(apiCallError({ statusCode: 429, responseBody: 'Rate limit reached for requests, please retry in 20s' }))).toBeUndefined();
    expect(getModelUsageLimitFailureMarker(apiCallError({ statusCode: 429 }))).toBeUndefined();
    expect(getModelUsageLimitFailureMarker(new Error('已达到使用上限'))).toBeUndefined();
    expect(getModelUsageLimitFailureMarker(undefined)).toBeUndefined();
  });
});
