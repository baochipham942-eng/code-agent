import { describe, expect, it, vi } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { classifySideChatFailure } from '../../../src/host/ipc/sideChatFailure';
import { withTransientRetry } from '../../../src/host/model/providers/retryStrategy';

// 真实重试链路（withTransientRetry）会打 warn 日志，测试里静音（与 retryStrategy.test.ts 同法）。
vi.mock('../../../src/host/model/providers/shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type ExpectedCause = ReturnType<typeof classifySideChatFailure>;

// 真实熔断包装的最小同构形状：文案只有「Retry stopped…」，原始错误挂在 cause 上。
const RETRY_STOPPED_MESSAGE = 'Retry stopped: the same retryable error repeated 3 times.';
const retryStopped = (underlying: unknown): Error =>
  Object.assign(new Error(RETRY_STOPPED_MESSAGE), { cause: underlying });

// 表驱动：每行是一条 provider/executor 原始文案（含中文），断言归并出的 cause token。
// 新 cause 的准入在这里扩行。429 频率行从 quota 改判 rate_limit 是本单有意重分类
// （订阅套餐的 429 通常是限流），不是旧文案漂移；429 + insufficient_quota 仍是 quota。
const TABLE: { expected: ExpectedCause; label: string; input: { message?: string; failureCode?: unknown; error?: unknown } }[] = [
  // ── auth：401/403 状态码与鉴权文案（中英）─────────────────────────────
  { expected: 'auth', label: 'http 401 code', input: { message: 'Error code: 401 - {"error":{"code":"1002","message":"invalid api key"}}' } },
  { expected: 'auth', label: 'http 403 code', input: { message: 'Error code: 403 - forbidden' } },
  { expected: 'auth', label: 'unauthorized', input: { message: 'Unauthorized request to provider' } },
  { expected: 'auth', label: 'invalid api key', input: { message: 'invalid_api_key: The API key provided is not valid' } },
  { expected: 'auth', label: 'Chinese auth wording', input: { message: '认证失败，请检查访问凭证' } },
  { expected: 'auth', label: 'Chinese permission wording', input: { message: '权限不足 (403)' } },
  { expected: 'auth', label: 'Chinese key wording', input: { message: '鉴权失败：API Key 可能无效或已过期' } },
  // ── quota：402 与余额/配额文案（中英）。裸 429 不再进这里。──────────────
  { expected: 'quota', label: 'http 402 code', input: { message: 'Error code: 402 - payment required' } },
  {
    expected: 'quota',
    label: '429 insufficient_quota',
    input: {
      error: Object.assign(new Error('You exceeded your current quota ... insufficient_quota'), { statusCode: 429 }),
    },
  },
  { expected: 'quota', label: 'insufficient balance', input: { message: 'insufficient balance, please recharge' } },
  { expected: 'quota', label: 'quota exceeded', input: { message: 'You exceeded your current quota, please check your plan and billing details' } },
  { expected: 'quota', label: 'Chinese balance wording', input: { message: '余额不足，请充值后重试' } },
  { expected: 'quota', label: 'Chinese quota wording', input: { message: '配额已用尽，今日无法继续调用' } },
  { expected: 'quota', label: 'Chinese arrears wording', input: { message: '账号已欠费，请前往控制台充值' } },
  // ── rate_limit：429 频率文案。本单从 quota 改判。──────────────────────
  { expected: 'rate_limit', label: 'http 429 rate', input: { message: 'Error code: 429 - rate limit exceeded, retry after 30s' } },
  // ── timeout：结构化失败码与超时文案（中英）────────────────────────────
  { expected: 'timeout', label: 'structured timeout code', input: { message: '执行中断', failureCode: AgentFailureCode.Timeout } },
  { expected: 'timeout', label: 'timeout wording', input: { message: 'Request timeout after 60000ms' } },
  { expected: 'timeout', label: 'ETIMEDOUT errno', input: { message: 'connect ETIMEDOUT 1.2.3.4:443' } },
  { expected: 'timeout', label: 'Chinese timeout wording', input: { message: '执行超时 (60秒)，已完成 1 次迭代' } },
  // ── network：连接类 errno 与网络文案（中英）──────────────────────────
  { expected: 'network', label: 'ECONNREFUSED', input: { message: 'connect ECONNREFUSED 127.0.0.1:443' } },
  { expected: 'network', label: 'ENOTFOUND / getaddrinfo', input: { message: 'getaddrinfo ENOTFOUND api.example.com' } },
  { expected: 'network', label: 'ECONNRESET', input: { message: 'ECONNRESET socket hang up' } },
  { expected: 'network', label: 'fetch failed', input: { message: 'fetch failed' } },
  { expected: 'network', label: 'browser network error', input: { message: 'Network request failed' } },
  { expected: 'network', label: 'Chinese network wording', input: { message: '网络连接失败，请检查网络设置' } },
  { expected: 'network', label: 'Chinese offline wording', input: { message: '无法连接到服务器' } },
  // ── unknown：不可归因文案兜底 ─────────────────────────────────────────
  { expected: 'unknown', label: 'busy model', input: { message: '模型正忙，请稍后再试' } },
  { expected: 'unknown', label: 'odd failure', input: { message: 'something odd happened' } },
  { expected: 'unknown', label: 'empty message', input: { message: '' } },
  // ── carried cause：熔断包装（Retry stopped…）cause 链上携带的原始错误 ────
  // 真机上重试耗尽后文案只剩「Retry stopped…」，原始 429/ECONNREFUSED 在
  // cause 链与保留的 status 上；这些行断言不带原始文案 signal 的底层错误
  // 也能归类（UI 验收 2026-10-11：此前全落 unknown）。
  { expected: 'auth', label: 'carried 401 status, wording-free message', input: { message: RETRY_STOPPED_MESSAGE, error: retryStopped(Object.assign(new Error('provider rejected the request'), { statusCode: 401 })) } },
  { expected: 'rate_limit', label: 'carried 429 status, wording-free message', input: { message: RETRY_STOPPED_MESSAGE, error: retryStopped(Object.assign(new Error('Too many requests, slow down'), { statusCode: 429 })) } },
  { expected: 'quota', label: 'carried 402 status, wording-free message', input: { message: RETRY_STOPPED_MESSAGE, error: retryStopped(Object.assign(new Error('provider requires an upgraded plan'), { status: 402 })) } },
  { expected: 'network', label: 'carried AI SDK connect wording', input: { message: RETRY_STOPPED_MESSAGE, error: retryStopped(new Error('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:443')) } },
  { expected: 'network', label: 'carried undici double wrap', input: { message: RETRY_STOPPED_MESSAGE, error: retryStopped(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) })) } },
];

describe('classifySideChatFailure', () => {
  it.each(TABLE)('$expected ← $label', ({ expected, input }) => {
    expect(classifySideChatFailure(input)).toBe(expected);
  });

  it('keeps the documented precedence: timeout code > auth > quota > rate_limit > timeout wording > network', () => {
    // 结构化超时码压过一切文案（executor 已判定超时，文案只是残留）。
    expect(classifySideChatFailure({ message: '401 unauthorized', failureCode: AgentFailureCode.Timeout })).toBe('timeout');
    // 鉴权压过配额：换 key 才是第一出路。
    expect(classifySideChatFailure({ message: 'Error code: 401, quota depleted for this key' })).toBe('auth');
    // 配额压过限流：429 但正文是余额信号时仍是 quota（classifyError 会先看 status 429）。
    expect(classifySideChatFailure({
      error: Object.assign(new Error('You exceeded your current quota ... insufficient_quota'), { statusCode: 429 }),
    })).toBe('quota');
    // 配额压过超时文案：欠费文案里带「超时」字样时，配额是更强的信号。
    expect(classifySideChatFailure({ message: '额度不足，请求已超时放弃' })).toBe('quota');
    // 限流压过超时文案：稍后再试，而不是当成请求超时。
    expect(classifySideChatFailure({ message: 'rate limit exceeded, request timeout' })).toBe('rate_limit');
    // 超时文案压过网络：网络栈的 ETIMEDOUT 属超时，不归 network。
    expect(classifySideChatFailure({ message: 'network timeout while dialing provider' })).toBe('timeout');
  });
});

// UI 验收 2026-10-11：真机上 429/ECONNREFUSED 被 ModelRouter 重试 3 次后熔断，
// 执行器最终抛出的文案只剩「Retry stopped…」——分类器不看 cause 链就全落 unknown。
// 这里用真实 withTransientRetry 把重试真正跑穿（不 mock 被测的重试机制），断言
// 熔断包装按携带的原始错误归类。
describe('classifySideChatFailure — real retry-exhaustion wrapper', () => {
  const CASES = [
    {
      label: '429 without digits or rate-limit wording in text',
      // AI SDK APICallError 形状：statusCode 是结构化字段，message 只有供应商文案。
      underlying: () => Object.assign(new Error('Too many requests, slow down'), { statusCode: 429 }),
      expected: 'rate_limit' as const,
    },
    {
      label: 'ECONNREFUSED via AI SDK connect wording',
      // handleFetchError 包出来的真实形状：message = `Cannot connect to API: ${cause.message}`。
      underlying: () => new Error('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:443'),
      expected: 'network' as const,
    },
  ];

  it.each(CASES)('classifies $label from the carried cause', async ({ underlying, expected }) => {
    const thrown = await withTransientRetry(() => Promise.reject(underlying()), {
      providerName: 'side-chat-exhaustion',
      model: 'test-model',
      maxRetries: 4,
      baseDelay: 1,
    }).then(
      () => { throw new Error('expected the fingerprint breaker to trip'); },
      (err: unknown) => err as Error,
    );

    // 确认真走的是熔断包装路径（与执行器在真机上抛出的同型错误）。
    expect(thrown.name).toBe('RepeatedRetryableFingerprintError');
    expect(thrown.message).toMatch(/^Retry stopped: the same retryable error repeated \d+ times\.$/);
    // 只看文案（不带携带的错误对象）时落 unknown——这正是 UI 验收发现的病灶。
    expect(classifySideChatFailure({ message: thrown.message })).toBe('unknown');
    // 带上错误对象后按 cause 链上的原始错误归类。
    expect(classifySideChatFailure({ message: thrown.message, error: thrown })).toBe(expected);
  });
});
