// ============================================================================
// ErrorClassifier Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { classifyError, getModelAuthFailureMarker, getModelUnavailableMarker, resolveAvailabilityFailure, MODEL_API_KEY_MISSING_CODE } from '../../../src/host/model/errorClassifier';
import type { ErrorClass } from '../../../src/host/model/errorClassifier';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function httpError(status: number, message = 'error'): unknown {
  return { status, message };
}

function msgError(message: string): unknown {
  return new Error(message);
}

// --------------------------------------------------------------------------
// Status-code classification
// --------------------------------------------------------------------------

describe('classifyError – status codes', () => {
  it('status 402 → quota_exhaustion', () => {
    expect(classifyError(httpError(402, 'Insufficient Balance'))).toBe<ErrorClass>('quota_exhaustion');
  });

  it('status 413 → overflow', () => {
    expect(classifyError(httpError(413))).toBe<ErrorClass>('overflow');
  });

  it('status 429 → rate_limit', () => {
    expect(classifyError(httpError(429))).toBe<ErrorClass>('rate_limit');
  });

  it('status 401 → auth', () => {
    expect(classifyError(httpError(401))).toBe<ErrorClass>('auth');
  });

  it('status 403 → auth', () => {
    expect(classifyError(httpError(403))).toBe<ErrorClass>('auth');
  });

  it('status 500 → unavailable', () => {
    expect(classifyError(httpError(500))).toBe<ErrorClass>('unavailable');
  });

  it('status 502 → unavailable', () => {
    expect(classifyError(httpError(502))).toBe<ErrorClass>('unavailable');
  });

  it('status 503 → unavailable', () => {
    expect(classifyError(httpError(503))).toBe<ErrorClass>('unavailable');
  });

  it('status 504 → unavailable', () => {
    expect(classifyError(httpError(504))).toBe<ErrorClass>('unavailable');
  });
});

// --------------------------------------------------------------------------
// Message-pattern classification
// --------------------------------------------------------------------------

describe('classifyError – message patterns', () => {
  it('明确余额不足文案 → quota_exhaustion', () => {
    expect(classifyError(msgError('账户余额不足，请充值'))).toBe<ErrorClass>('quota_exhaustion');
  });

  it.each([
    'Your credit balance is too low to access the Anthropic API',
    'You have run out of credits',
    'This request would exceed your credit limit',
  ])('明确 credit 余额耗尽文案 → quota_exhaustion: %s', (message) => {
    expect(classifyError(msgError(message))).toBe<ErrorClass>('quota_exhaustion');
  });

  it('credit card 无关文案不误判为 quota_exhaustion', () => {
    expect(classifyError(msgError('Please update your credit card details'))).toBe<ErrorClass>('unknown');
  });

  // overflow
  it('"context_length_exceeded" → overflow', () => {
    expect(classifyError(msgError('context_length_exceeded'))).toBe<ErrorClass>('overflow');
  });

  it('"maximum context length" → overflow', () => {
    expect(classifyError(msgError('maximum context length reached'))).toBe<ErrorClass>('overflow');
  });

  it('"prompt is too long" → overflow', () => {
    expect(classifyError(msgError('prompt is too long for model'))).toBe<ErrorClass>('overflow');
  });

  it('"request too large" → overflow', () => {
    expect(classifyError(msgError('request too large'))).toBe<ErrorClass>('overflow');
  });

  it('"token limit" → overflow', () => {
    expect(classifyError(msgError('You have exceeded the token limit'))).toBe<ErrorClass>('overflow');
  });

  // rate_limit
  it('"rate limit" → rate_limit', () => {
    expect(classifyError(msgError('rate limit exceeded'))).toBe<ErrorClass>('rate_limit');
  });

  it('"too many requests" → rate_limit', () => {
    expect(classifyError(msgError('too many requests'))).toBe<ErrorClass>('rate_limit');
  });

  it('"quota exceeded" → rate_limit', () => {
    expect(classifyError(msgError('quota exceeded for this month'))).toBe<ErrorClass>('rate_limit');
  });

  // auth
  it('"invalid_api_key" → auth', () => {
    expect(classifyError(msgError('invalid_api_key supplied'))).toBe<ErrorClass>('auth');
  });

  it('"authentication_error" → auth', () => {
    expect(classifyError(msgError('authentication_error'))).toBe<ErrorClass>('auth');
  });

  it('"invalid token" → auth', () => {
    expect(classifyError(msgError('invalid token'))).toBe<ErrorClass>('auth');
  });

  it('"unauthorized" → auth', () => {
    expect(classifyError(msgError('unauthorized access'))).toBe<ErrorClass>('auth');
  });

  it('"forbidden" → auth', () => {
    expect(classifyError(msgError('forbidden'))).toBe<ErrorClass>('auth');
  });

  // network
  it('"ECONNRESET" (uppercase) → network', () => {
    expect(classifyError(msgError('ECONNRESET'))).toBe<ErrorClass>('network');
  });

  it('"econnrefused" → network', () => {
    expect(classifyError(msgError('connect ECONNREFUSED 127.0.0.1:8080'))).toBe<ErrorClass>('network');
  });

  it('"etimedout" → network', () => {
    expect(classifyError(msgError('connect ETIMEDOUT'))).toBe<ErrorClass>('network');
  });

  it('"socket hang up" → network', () => {
    expect(classifyError(msgError('socket hang up'))).toBe<ErrorClass>('network');
  });

  it('"network error" → network', () => {
    expect(classifyError(msgError('network error'))).toBe<ErrorClass>('network');
  });

  it('"fetch failed" → network', () => {
    expect(classifyError(msgError('fetch failed'))).toBe<ErrorClass>('network');
  });

  // unavailable
  it('"service unavailable" → unavailable', () => {
    expect(classifyError(msgError('service unavailable'))).toBe<ErrorClass>('unavailable');
  });

  it('"bad gateway" → unavailable', () => {
    expect(classifyError(msgError('bad gateway'))).toBe<ErrorClass>('unavailable');
  });

  it('"gateway timeout" → unavailable', () => {
    expect(classifyError(msgError('gateway timeout'))).toBe<ErrorClass>('unavailable');
  });

  it('"internal server error" → unavailable', () => {
    expect(classifyError(msgError('internal server error'))).toBe<ErrorClass>('unavailable');
  });
});

// --------------------------------------------------------------------------
// Unknown / edge cases
// --------------------------------------------------------------------------

describe('classifyError – unknown and edge cases', () => {
  it('unrecognised message → unknown', () => {
    expect(classifyError(msgError('something completely different'))).toBe<ErrorClass>('unknown');
  });

  it('null → unknown', () => {
    expect(classifyError(null)).toBe<ErrorClass>('unknown');
  });

  it('undefined → unknown', () => {
    expect(classifyError(undefined)).toBe<ErrorClass>('unknown');
  });

  it('plain string → unknown when unrecognised', () => {
    expect(classifyError('mystery error')).toBe<ErrorClass>('unknown');
  });

  it('status code takes priority over message', () => {
    // status 413 should win even if message says "network error"
    expect(classifyError({ status: 413, message: 'network error' })).toBe<ErrorClass>('overflow');
  });

  it('statusCode field is also accepted', () => {
    expect(classifyError({ statusCode: 429, message: '' })).toBe<ErrorClass>('rate_limit');
  });
});

// --------------------------------------------------------------------------
// 缺 key / 鉴权失败的结构化识别（批 X5 ③）
//
// 与 classifyError 刻意不同：这个结果直接决定用户看到的那句人话，所以**只认字段**。
// message 是上游自由文案，按文本认必然漏，漏了还静默（deny-list 教训）。
// --------------------------------------------------------------------------

describe('400 Unsupported model → 模型不可用，不误伤 temperature', () => {
  it('HTTP 400 Unsupported model 归类为 model_deprecated，并产出 MODEL_UNAVAILABLE 标记', () => {
    const error = Object.assign(new Error('Unsupported model'), { status: 400, provider: 'longcat', model: 'LongCat-2.0-Preview' });
    expect(classifyError(error)).toBe<ErrorClass>('model_deprecated');
    expect(getModelUnavailableMarker(error)).toEqual({
      code: 'MODEL_UNAVAILABLE',
      provider: 'longcat',
      model: 'LongCat-2.0-Preview',
    });
    expect(resolveAvailabilityFailure(error)).toEqual({ scope: 'model', kind: 'model' });
    expect(getModelAuthFailureMarker(error)).toBeUndefined();
  });

  it('Unsupported value: temperature 不认成模型停用', () => {
    const error = Object.assign(new Error("Unsupported value: 'temperature' does not support 0.7 with this model."), { status: 400 });
    expect(classifyError(error)).not.toBe<ErrorClass>('model_deprecated');
    expect(getModelUnavailableMarker(error)).toBeUndefined();
  });

  it('message 里 model 后面的 Unsupported value 参数错误也不认成模型停用（收窄 model.*unsupported）', () => {
    // ai-review PR#1918 Nit：model.*unsupported 宽匹配会把带模型名的参数错误吞进 model_deprecated，
    // 进而让 loopDecision 走 fallback + 打 30 分钟停用标记。收窄后只剩明确指向模型的句式。
    const error = new Error("Invalid request to model glm-5: Unsupported value: 'temperature'");
    expect(classifyError(error)).not.toBe<ErrorClass>('model_deprecated');
    expect(getModelUnavailableMarker(error)).toBeUndefined();
  });

  it('明确指向模型的句式仍认：Unsupported model / model … not supported / does not exist / not found', () => {
    expect(classifyError(new Error('Unsupported model: LongCat-2.0-Preview'))).toBe<ErrorClass>('model_deprecated');
    expect(classifyError(new Error('The model glm-4-flash is not supported'))).toBe<ErrorClass>('model_deprecated');
    expect(classifyError(new Error('model LongCat-2.0-Preview does not exist'))).toBe<ErrorClass>('model_deprecated');
    expect(classifyError(new Error('model glm-4 not found'))).toBe<ErrorClass>('model_deprecated');
  });

  it('401 仍是供应商级鉴权，不是模型停用', () => {
    const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    expect(resolveAvailabilityFailure(error)).toEqual({ scope: 'provider', kind: 'auth' });
    expect(getModelUnavailableMarker(error)).toBeUndefined();
  });
});

describe('getModelAuthFailureMarker', () => {
  it('HTTP 401 / 403 认成鉴权失败，并带上认得出的 provider/model', () => {
    expect(getModelAuthFailureMarker({ status: 401, provider: 'openai', model: 'gpt-4o' })).toEqual({
      code: 'MODEL_AUTH',
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(getModelAuthFailureMarker({ status: 403 })).toEqual({ code: 'MODEL_AUTH' });
  });

  it('AI SDK APICallError 形状（HTTP 码在 statusCode）同样认得（build 45 真机 403 漏成兜底话）', () => {
    const apiCallError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    expect(getModelAuthFailureMarker(apiCallError)).toEqual({ code: 'MODEL_AUTH' });
    expect(getModelAuthFailureMarker(new Error('run failed', { cause: apiCallError }))).toEqual({ code: 'MODEL_AUTH' });
  });

  it('本地缺 key 的自有 code 同样认成鉴权失败', () => {
    expect(getModelAuthFailureMarker({ code: MODEL_API_KEY_MISSING_CODE, provider: 'deepseek' }))
      .toEqual({ code: 'MODEL_AUTH', provider: 'deepseek' });
  });

  it('沿 cause 链上溯（重试/agent loop 会把原始错误包起来）', () => {
    const wrapped = new Error('run failed', { cause: new Error('inference failed', { cause: { status: 401, provider: 'zhipu' } }) });
    expect(getModelAuthFailureMarker(wrapped)).toEqual({ code: 'MODEL_AUTH', provider: 'zhipu' });
  });

  it('只有英文原文、没有结构化字段时不认（判据是字段不是文本）', () => {
    expect(getModelAuthFailureMarker(new Error("You didn't provide an API key."))).toBeUndefined();
    expect(getModelAuthFailureMarker(new Error('401 Unauthorized'))).toBeUndefined();
  });

  it('其他状态码不冒充鉴权失败', () => {
    expect(getModelAuthFailureMarker({ status: 500 })).toBeUndefined();
    expect(getModelAuthFailureMarker({ status: 429 })).toBeUndefined();
    expect(getModelAuthFailureMarker(undefined)).toBeUndefined();
  });
});

describe('quota_exhaustion → 供应商级 quota（余额或额度用完了），不再冒充密钥', () => {
  it('402 / 余额不足文案 / x-ratelimit-remaining 0 标 {scope:provider, kind:quota}', () => {
    expect(resolveAvailabilityFailure(Object.assign(new Error('Payment required'), { status: 402 })))
      .toEqual({ scope: 'provider', kind: 'quota' });
    expect(resolveAvailabilityFailure(new Error('Insufficient balance, please top up')))
      .toEqual({ scope: 'provider', kind: 'quota' });
    expect(resolveAvailabilityFailure(Object.assign(new Error('rate limited'), { headers: { 'x-ratelimit-remaining': '0' } })))
      .toEqual({ scope: 'provider', kind: 'quota' });
  });

  it('401/403 仍是 auth（mimo 曾用 401 表达额度耗尽，单凭响应分不出 key 与余额）', () => {
    expect(resolveAvailabilityFailure(Object.assign(new Error('Unauthorized'), { status: 401 })))
      .toEqual({ scope: 'provider', kind: 'auth' });
    expect(resolveAvailabilityFailure(Object.assign(new Error('Forbidden'), { statusCode: 403 })))
      .toEqual({ scope: 'provider', kind: 'auth' });
  });
});
