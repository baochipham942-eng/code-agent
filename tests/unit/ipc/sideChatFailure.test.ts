import { describe, expect, it } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { classifySideChatFailure } from '../../../src/host/ipc/sideChatFailure';

type ExpectedCause = ReturnType<typeof classifySideChatFailure>;

// 表驱动：每行是一条 provider/executor 原始文案（含中文），断言归并出的 cause token。
// 新 cause 的准入在这里扩行，不回改旧行——旧文案的分类漂移是破坏性变更。
const TABLE: { expected: ExpectedCause; label: string; input: { message?: string; failureCode?: unknown } }[] = [
  // ── auth：401/403 状态码与鉴权文案（中英）─────────────────────────────
  { expected: 'auth', label: 'http 401 code', input: { message: 'Error code: 401 - {"error":{"code":"1002","message":"invalid api key"}}' } },
  { expected: 'auth', label: 'http 403 code', input: { message: 'Error code: 403 - forbidden' } },
  { expected: 'auth', label: 'unauthorized', input: { message: 'Unauthorized request to provider' } },
  { expected: 'auth', label: 'invalid api key', input: { message: 'invalid_api_key: The API key provided is not valid' } },
  { expected: 'auth', label: 'Chinese auth wording', input: { message: '认证失败，请检查访问凭证' } },
  { expected: 'auth', label: 'Chinese permission wording', input: { message: '权限不足 (403)' } },
  { expected: 'auth', label: 'Chinese key wording', input: { message: '鉴权失败：API Key 可能无效或已过期' } },
  // ── quota：402/429 状态码与配额/账单文案（中英）───────────────────────
  { expected: 'quota', label: 'http 402 code', input: { message: 'Error code: 402 - payment required' } },
  { expected: 'quota', label: 'http 429 rate', input: { message: 'Error code: 429 - rate limit exceeded, retry after 30s' } },
  { expected: 'quota', label: 'insufficient balance', input: { message: 'insufficient balance, please recharge' } },
  { expected: 'quota', label: 'quota exceeded', input: { message: 'You exceeded your current quota, please check your plan and billing details' } },
  { expected: 'quota', label: 'Chinese balance wording', input: { message: '余额不足，请充值后重试' } },
  { expected: 'quota', label: 'Chinese quota wording', input: { message: '配额已用尽，今日无法继续调用' } },
  { expected: 'quota', label: 'Chinese arrears wording', input: { message: '账号已欠费，请前往控制台充值' } },
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
];

describe('classifySideChatFailure', () => {
  it.each(TABLE)('$expected ← $label', ({ expected, input }) => {
    expect(classifySideChatFailure(input)).toBe(expected);
  });

  it('keeps the documented precedence: timeout code > auth > quota > timeout wording > network', () => {
    // 结构化超时码压过一切文案（executor 已判定超时，文案只是残留）。
    expect(classifySideChatFailure({ message: '401 unauthorized', failureCode: AgentFailureCode.Timeout })).toBe('timeout');
    // 鉴权压过配额：换 key 才是第一出路。
    expect(classifySideChatFailure({ message: 'Error code: 401, quota depleted for this key' })).toBe('auth');
    // 配额压过超时文案：欠费文案里带「超时」字样时，配额是更强的信号。
    expect(classifySideChatFailure({ message: '额度不足，请求已超时放弃' })).toBe('quota');
    // 超时文案压过网络：网络栈的 ETIMEDOUT 属超时，不归 network。
    expect(classifySideChatFailure({ message: 'network timeout while dialing provider' })).toBe('timeout');
  });
});
