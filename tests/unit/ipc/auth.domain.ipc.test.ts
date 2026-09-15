import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// auth.ipc.ts 派发特征测试（RQ-183 续作·AUTH 刀迁表前钉住现状）：既有 auth.ipc.test.ts 只钉「抛空对象 → AUTH_REQUEST_FAILED
// 且日志不含凭据」一条。这里补齐 15 个 action 的委派与参数、四个无返回 action 的 null、getStatus 的 analyticsDistinctId、
// 未知 action 的 INVALID_ACTION 'Unknown action:'，以及兜底文案提取链（Error.message → cause → error_description →
// 字符串 → 回落）与带 action 的 warn 日志。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  auth: {
    getStatus: vi.fn(),
    signInWithEmail: vi.fn(async (..._a: unknown[]) => ({ user: { id: 'u1' } })),
    signUpWithEmail: vi.fn(async (..._a: unknown[]) => ({ user: { id: 'u2' } })),
    signInWithOAuth: vi.fn(async (..._a: unknown[]) => ({ ignored: true })),
    signInWithQuickToken: vi.fn(async (..._a: unknown[]) => ({ user: { id: 'u3' } })),
    signOut: vi.fn(async () => ({ ignored: true })),
    getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
    updateProfile: vi.fn(async (..._a: unknown[]) => ({ id: 'u1', name: 'n' })),
    generateQuickLoginToken: vi.fn(async () => 'qt-1'),
    resetPassword: vi.fn(async (..._a: unknown[]) => ({ sent: true })),
    updatePassword: vi.fn(async (..._a: unknown[]) => ({ updated: true })),
    handlePasswordResetCallback: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  },
  storage: {
    saveLoginCredentials: vi.fn((..._a: unknown[]) => 'ignored'),
    getSavedCredentials: vi.fn(() => ({ email: 'a@b.c', password: 'p' })),
    clearSavedCredentials: vi.fn(() => 'ignored'),
  },
  warn: vi.fn(),
  distinctId: vi.fn((id: string) => `ph-${id}`),
}));

vi.mock('../../../src/host/services', () => ({ getAuthService: () => h.auth }));
vi.mock('../../../src/host/services/core/secureStorage', () => ({ getSecureStorage: () => h.storage }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/observability/posthogNode', () => ({
  getPostHogDistinctId: (id: string) => h.distinctId(id),
}));

import { registerAuthHandlers } from '../../../src/host/ipc/auth.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, Handler>();
  registerAuthHandlers({ handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never);
  handler = handlers.get(IPC_DOMAINS.AUTH)!;
});

describe('auth.ipc dispatch 特征：委派', () => {
  it('getStatus：有用户时附 analyticsDistinctId，无用户时为 undefined', async () => {
    h.auth.getStatus.mockResolvedValueOnce({ isAuthenticated: true, user: { id: 'u1' } });
    expect(await call('getStatus')).toEqual({
      success: true,
      data: { isAuthenticated: true, user: { id: 'u1' }, analyticsDistinctId: 'ph-u1' },
    });
    expect(h.distinctId).toHaveBeenCalledWith('u1');
    h.auth.getStatus.mockResolvedValueOnce({ isAuthenticated: false, user: null });
    expect(await call('getStatus')).toEqual({
      success: true,
      data: { isAuthenticated: false, user: null, analyticsDistinctId: undefined },
    });
  });

  it('邮箱 / token / 资料 / 密码类：参数原样透传、返回值原样回传', async () => {
    expect(await call('signInEmail', { email: 'a@b.c', password: 'p' })).toEqual({ success: true, data: { user: { id: 'u1' } } });
    expect(h.auth.signInWithEmail).toHaveBeenCalledWith('a@b.c', 'p');
    expect(await call('signUpEmail', { email: 'a@b.c', password: 'p', inviteCode: 'inv' })).toEqual({ success: true, data: { user: { id: 'u2' } } });
    expect(h.auth.signUpWithEmail).toHaveBeenCalledWith('a@b.c', 'p', 'inv');
    expect(await call('signInToken', { token: 't' })).toEqual({ success: true, data: { user: { id: 'u3' } } });
    expect(h.auth.signInWithQuickToken).toHaveBeenCalledWith('t');
    expect(await call('getUser')).toEqual({ success: true, data: { id: 'u1' } });
    expect(await call('updateProfile', { updates: { name: 'n' } })).toEqual({ success: true, data: { id: 'u1', name: 'n' } });
    expect(h.auth.updateProfile).toHaveBeenCalledWith({ name: 'n' });
    expect(await call('generateQuickToken')).toEqual({ success: true, data: 'qt-1' });
    expect(await call('resetPassword', { email: 'a@b.c' })).toEqual({ success: true, data: { sent: true } });
    expect(h.auth.resetPassword).toHaveBeenCalledWith('a@b.c');
    expect(await call('updatePassword', { password: 'np' })).toEqual({ success: true, data: { updated: true } });
    expect(h.auth.updatePassword).toHaveBeenCalledWith('np');
    expect(await call('passwordResetCallback', { accessToken: 'at', refreshToken: 'rt' })).toEqual({ success: true, data: { ok: true } });
    expect(h.auth.handlePasswordResetCallback).toHaveBeenCalledWith('at', 'rt');
  });

  it('signInOAuth / signOut / saveCredentials / clearSavedCredentials：丢弃服务返回值，统一返回 null', async () => {
    expect(await call('signInOAuth', { provider: 'github' })).toEqual({ success: true, data: null });
    expect(h.auth.signInWithOAuth).toHaveBeenCalledWith('github');
    expect(await call('signOut')).toEqual({ success: true, data: null });
    expect(await call('saveCredentials', { email: 'a@b.c', password: 'p' })).toEqual({ success: true, data: null });
    expect(h.storage.saveLoginCredentials).toHaveBeenCalledWith('a@b.c', 'p');
    expect(await call('clearSavedCredentials')).toEqual({ success: true, data: null });
    expect(h.storage.clearSavedCredentials).toHaveBeenCalledTimes(1);
    expect(await call('getSavedCredentials')).toEqual({ success: true, data: { email: 'a@b.c', password: 'p' } });
  });
});

describe('auth.ipc dispatch 特征：兜底', () => {
  it('未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛错文案提取链：Error.message → cause → error_description → 字符串 → 回落；warn 带 action', async () => {
    h.auth.signOut.mockRejectedValueOnce(new Error('session gone'));
    expect(await call('signOut')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'session gone' } });
    expect(h.warn).toHaveBeenLastCalledWith('Auth IPC action failed', { action: 'signOut', error: 'session gone' });

    h.auth.getCurrentUser.mockRejectedValueOnce(Object.assign(new Error(''), { cause: { message: 'jwt expired' } }));
    expect(await call('getUser')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'jwt expired' } });

    h.auth.resetPassword.mockRejectedValueOnce({ error_description: 'rate limited' });
    expect(await call('resetPassword', { email: 'a@b.c' })).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'rate limited' } });

    h.auth.generateQuickLoginToken.mockRejectedValueOnce('plain failure');
    expect(await call('generateQuickToken')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'plain failure' } });
    expect(h.warn).toHaveBeenLastCalledWith('Auth IPC action failed', { action: 'generateQuickToken', error: 'plain failure' });

    h.auth.updatePassword.mockRejectedValueOnce({});
    expect(await call('updatePassword', { password: 'np' })).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'AUTH_REQUEST_FAILED' } });
  });
});
