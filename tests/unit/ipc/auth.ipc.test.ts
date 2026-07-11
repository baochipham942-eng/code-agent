import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

type Handler = (_event: unknown, request: { action: string; payload?: unknown }) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  authService: {
    signInWithEmail: vi.fn(),
  },
  secureStorage: {
    getSavedCredentials: vi.fn(),
    saveLoginCredentials: vi.fn(),
    clearSavedCredentials: vi.fn(),
  },
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getAuthService: () => mocks.authService,
}));

vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => mocks.secureStorage,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

describe('registerAuthHandlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    const { registerAuthHandlers } = await import('../../../src/host/ipc/auth.ipc');
    registerAuthHandlers({
      handle: (channel: string, handler: Handler) => {
        mocks.handlers.set(channel, handler);
      },
    } as never);
  });

  it('returns a stable auth request failure and logs without credentials when an empty object is thrown', async () => {
    mocks.authService.signInWithEmail.mockRejectedValueOnce({});
    const handler = mocks.handlers.get(IPC_DOMAINS.AUTH);

    const response = await handler?.(null, {
      action: 'signInEmail',
      payload: { email: 'teammate@example.com', password: 'secret-password' },
    });

    expect(response).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'AUTH_REQUEST_FAILED' },
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('Auth IPC action failed', {
      action: 'signInEmail',
      error: 'AUTH_REQUEST_FAILED',
    });
    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('teammate@example.com');
    expect(logged).not.toContain('secret-password');
  });
});
