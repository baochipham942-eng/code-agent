import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerFn } from '../../../src/host/platform';
import { installDomainRoutes } from '../../../src/host/ipc/domainRoutes/registry';
import { defineSessionRoutes } from '../../../src/host/ipc/domainRoutes/sessionRoutes';
import { createWebSessionContext } from '../../../src/web/sessionDomainHandler';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({}),
}));
vi.mock('../../../src/host/task', () => ({ getTaskManager: () => ({}) }));
vi.mock('../../../src/host/services/core/configService', () => ({ getConfigService: () => ({}) }));
vi.mock('../../../src/host/app/agentAppService', () => ({
  AgentAppServiceImpl: class {
    createSession = mocks.createSession;
  },
}));

describe('web session domain expert creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue({
      id: 'session-expert',
      title: '牧之',
      metadata: { expertThread: { roleId: '牧之', setAt: 42 } },
    });
  });

  it('routes create through the application service with expertRoleId intact', async () => {
    const handlers = new Map<string, HandlerFn>();
    const ctx = createWebSessionContext({
      getDbAvailable: () => true,
      hasActiveRun: () => false,
      getCurrentSessionId: () => null,
      setCurrentSessionId: vi.fn(),
      getDurableRunReadService: () => undefined,
    });
    // 与 webServer 生产装配同构：单源表 web 形态 + web context
    installDomainRoutes(
      { handle: (channel, handler) => { handlers.set(channel, handler); } },
      defineSessionRoutes('web'),
      ctx,
    );

    const response = await handlers.get('domain:session')?.({}, {
      action: 'create',
      payload: {
        title: '牧之',
        workingDirectory: '/workspace',
        expertRoleId: '牧之',
      },
    });

    expect(mocks.createSession).toHaveBeenCalledWith({
      title: '牧之',
      workingDirectory: '/workspace',
      expertRoleId: '牧之',
    });
    expect(response).toMatchObject({
      success: true,
      data: { metadata: { expertThread: { roleId: '牧之' } } },
    });
  });
});
