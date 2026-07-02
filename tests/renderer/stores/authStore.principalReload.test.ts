import { beforeEach, describe, expect, it, vi } from 'vitest';

// authStore 只从 sessionStore 导入 reloadSessionsForAuthChange，整体 mock 掉以隔离验证接线
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  reloadSessionsForAuthChange: vi.fn().mockResolvedValue(undefined),
}));

const listeners = new Map<string, (event: unknown) => void>();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: vi.fn((channel: string, cb: (event: unknown) => void) => {
      listeners.set(channel, cb);
    }),
    off: vi.fn(),
    isAvailable: () => false,
  },
}));

import { initializeAuthStore, useAuthStore } from '../../../src/renderer/stores/authStore';
import { reloadSessionsForAuthChange } from '../../../src/renderer/stores/sessionStore';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const mockReload = vi.mocked(reloadSessionsForAuthChange);

function makeUser(id: string) {
  return { id, email: `${id}@test.dev` };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 启动闪烁根因回归（接线层）：host 启动时会对同一用户重复推送 signed_in
 * （缓存用户 → profile 验证完成）。同主体事件必须以 principalChanged:false 下发，
 * 否则会话态被清空重建 → 窗口可见后闪 1-2 下。
 */
describe('authStore auth 事件 → 会话重载的主体判定', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: {
        invoke: vi.fn(async (_domain: string, action: string) => {
          if (action === 'getStatus') {
            return { success: true, data: null };
          }
          return { success: true, data: null };
        }),
      },
    };
    useAuthStore.setState({ user: null, isAuthenticated: false });
    await initializeAuthStore();
  });

  it('首次 signed_in（null→user）按主体变化处理，重复 signed_in（同 user）静默刷新', async () => {
    const authHandler = listeners.get(IPC_CHANNELS.AUTH_EVENT);
    expect(authHandler).toBeDefined();

    authHandler!({ type: 'signed_in', user: makeUser('u1') });
    await flushMicrotasks();
    expect(mockReload).toHaveBeenLastCalledWith({ principalChanged: true });

    authHandler!({ type: 'signed_in', user: makeUser('u1') });
    await flushMicrotasks();
    expect(mockReload).toHaveBeenLastCalledWith({ principalChanged: false });
  });

  it('换账号（userA→userB）按主体变化处理', async () => {
    const authHandler = listeners.get(IPC_CHANNELS.AUTH_EVENT)!;

    authHandler({ type: 'signed_in', user: makeUser('u1') });
    await flushMicrotasks();
    authHandler({ type: 'signed_in', user: makeUser('u2') });
    await flushMicrotasks();
    expect(mockReload).toHaveBeenLastCalledWith({ principalChanged: true });
  });

  it('signed_out：已登录→登出是主体变化，重复 signed_out（本就匿名）是同主体', async () => {
    const authHandler = listeners.get(IPC_CHANNELS.AUTH_EVENT)!;

    authHandler({ type: 'signed_in', user: makeUser('u1') });
    await flushMicrotasks();
    authHandler({ type: 'signed_out' });
    await flushMicrotasks();
    expect(mockReload).toHaveBeenLastCalledWith({ principalChanged: true });

    authHandler({ type: 'signed_out' });
    await flushMicrotasks();
    expect(mockReload).toHaveBeenLastCalledWith({ principalChanged: false });
  });
});
