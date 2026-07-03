import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getSessionManager } from '../../../src/host/services';
import { getModelSessionState, resetModelSessionState } from '../../../src/host/session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../../../src/host/session/modelOverridePersistence';
import { loadStreamSnapshot } from '../../../src/host/session/streamSnapshot';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: vi.fn(),
}));

vi.mock('../../../src/host/session/streamSnapshot', () => ({
  loadStreamSnapshot: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbMocks,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

vi.mock('../../../src/host/session/modelOverridePersistence', () => ({
  persistModelOverride: vi.fn(async () => true),
  clearPersistedModelOverride: vi.fn(async () => true),
  rehydrateModelOverrideFromSession: vi.fn(() => null),
}));

function createService(taskManager: unknown, currentSessionId = 'session-1'): AgentAppServiceImpl {
  return new AgentAppServiceImpl(
    () => taskManager as never,
    () => null,
    () => currentSessionId,
    vi.fn(),
  );
}

describe('AgentAppService model override persistence wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelSessionState();
    vi.mocked(loadStreamSnapshot).mockReturnValue(null);
  });

  it('switchModel writes the in-memory override and persists it', async () => {
    const service = createService({});

    const result = await service.switchModel({
      sessionId: 'session-1',
      provider: 'zhipu',
      model: 'glm-5',
      adaptive: false,
    });

    expect(getModelSessionState().getOverride('session-1')).toMatchObject({
      provider: 'zhipu',
      model: 'glm-5',
    });
    expect(persistModelOverride).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ provider: 'zhipu', model: 'glm-5' }),
    );
    expect(result).toEqual({ persisted: true });
  });

  it('switchModel reports persisted=false when persistence fails (audit R1-HIGH2)', async () => {
    vi.mocked(persistModelOverride).mockResolvedValueOnce(false);
    const service = createService({});

    const result = await service.switchModel({
      sessionId: 'session-1',
      provider: 'zhipu',
      model: 'glm-5',
    });

    expect(result).toEqual({ persisted: false });
    // 内存 override 本轮仍生效
    expect(getModelSessionState().getOverride('session-1')).toMatchObject({ model: 'glm-5' });
  });

  it('clearModelOverride clears memory and the persisted marker', async () => {
    getModelSessionState().setOverride('session-1', { provider: 'zhipu', model: 'glm-5' });
    const service = createService({});

    await service.clearModelOverride('session-1');

    expect(getModelSessionState().getOverride('session-1')).toBeNull();
    expect(clearPersistedModelOverride).toHaveBeenCalledWith('session-1');
  });

  it('getModelOverride rehydrates from DB when the in-memory map is empty (audit R2 IPC symmetry)', () => {
    const dbSession = {
      id: 'session-1',
      metadata: { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
    };
    dbMocks.getSession.mockReturnValue(dbSession);
    vi.mocked(rehydrateModelOverrideFromSession).mockReturnValueOnce({
      provider: 'zhipu',
      model: 'glm-5',
      setAt: 1,
    } as never);
    const service = createService({});

    const override = service.getModelOverride('session-1');

    // owner filter（audit R3-LOW）：不读当前 owner 不可访问会话的 marker
    expect(dbMocks.getSession).toHaveBeenCalledWith('session-1', { userId: 'user-1' });
    expect(rehydrateModelOverrideFromSession).toHaveBeenCalledWith(dbSession);
    expect(override).toMatchObject({ provider: 'zhipu', model: 'glm-5' });
  });

  it('getModelOverride returns undefined when DB lookup throws (no crash)', () => {
    dbMocks.getSession.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const service = createService({});

    expect(service.getModelOverride('session-1')).toBeUndefined();
  });

  it('loadSession rehydrates the model override from the restored session', async () => {
    const restoredSession = {
      id: 'session-1',
      title: 'Restored',
      messages: [],
      metadata: { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
    };
    vi.mocked(getSessionManager).mockReturnValue({
      restoreSession: vi.fn(async () => restoredSession),
    } as never);
    const taskManager = {
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
      getOrCreateCurrentOrchestrator: vi.fn(() => null),
    };
    const service = createService(taskManager);

    await service.loadSession('session-1');

    expect(rehydrateModelOverrideFromSession).toHaveBeenCalledWith(restoredSession);
  });
});
