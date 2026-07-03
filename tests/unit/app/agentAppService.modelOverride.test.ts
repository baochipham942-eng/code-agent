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
