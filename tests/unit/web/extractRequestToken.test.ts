// ============================================================================
// sseConnectionLimit.extractRequestToken：与 authMiddleware 同口径的 key 提取。
// 现有 sseConnectionLimit.test.ts 只测 SseConnectionLimiter 计数器。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { extractRequestToken } from '../../../src/web/helpers/sseConnectionLimit';

function req(partial: {
  authorization?: string;
  token?: string | string[];
}): Request {
  return {
    headers: partial.authorization ? { authorization: partial.authorization } : {},
    query: partial.token !== undefined ? { token: partial.token } : {},
  } as unknown as Request;
}

describe('extractRequestToken', () => {
  it('prefers Bearer header over query token', () => {
    expect(extractRequestToken(req({
      authorization: 'Bearer header-token',
      token: 'query-token',
    }))).toBe('header-token');
  });

  it('falls back to string query token', () => {
    expect(extractRequestToken(req({ token: 'query-only' }))).toBe('query-only');
  });

  it('ignores non-Bearer Authorization schemes', () => {
    expect(extractRequestToken(req({ authorization: 'Basic abc' }))).toBe('anon');
  });

  it('returns anon for missing or empty credentials (shared fail-closed bucket)', () => {
    expect(extractRequestToken(req({}))).toBe('anon');
    expect(extractRequestToken(req({ token: '' }))).toBe('anon');
    expect(extractRequestToken(req({ token: ['a', 'b'] }))).toBe('anon');
  });
});
