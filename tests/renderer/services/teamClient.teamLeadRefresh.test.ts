import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
  loadSessions: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ loadSessions: mocks.loadSessions }),
  },
}));

import { launchRecipe } from '../../../src/renderer/services/teamClient';

describe('teamClient lead metadata refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessions.mockResolvedValue(undefined);
  });

  it('组队发起成功后从标准 session list 读回 metadata', async () => {
    mocks.invokeDomain.mockResolvedValue({ ok: true });

    await expect(launchRecipe('session-1', 'recipe-1', '会员增长'))
      .resolves.toEqual({ ok: true });

    expect(mocks.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.TEAM, 'launchRecipe', {
      sessionId: 'session-1',
      recipeId: 'recipe-1',
      topic: '会员增长',
    });
    expect(mocks.loadSessions).toHaveBeenCalledWith({ silent: true });
  });

  it('组队发起失败时不刷新会话列表', async () => {
    mocks.invokeDomain.mockResolvedValue({ ok: false, error: '运行时未就绪' });

    await launchRecipe('session-1', 'recipe-1', '会员增长');

    expect(mocks.loadSessions).not.toHaveBeenCalled();
  });
});
