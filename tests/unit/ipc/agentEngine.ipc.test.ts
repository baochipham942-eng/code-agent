import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registryInvalidate: vi.fn(),
  registryList: vi.fn(),
  catalogInvalidate: vi.fn(),
  catalogRead: vi.fn(),
}));

vi.mock('../../../src/host/services/agentEngine', () => ({
  getAgentEngineRegistry: () => ({
    invalidate: mocks.registryInvalidate,
    list: mocks.registryList,
  }),
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineModelCatalog', () => ({
  getAgentEngineCatalogEngine: vi.fn(),
  resolveAgentEngineCatalogModel: vi.fn(),
  getRemoteAgentEngineModelCatalogService: () => ({
    invalidate: mocks.catalogInvalidate,
    readCatalog: mocks.catalogRead,
  }),
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineHistoryImport', () => ({
  AgentEngineHistoryImportError: class AgentEngineHistoryImportError extends Error {},
  getAgentEngineHistoryImportService: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: vi.fn(),
}));

import { registerAgentEngineHandlers } from '../../../src/host/ipc/agentEngine.ipc';

describe('Agent Engine IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('manual detection invalidates and waits for both engine sources and a fresh model catalog', async () => {
    let releaseRegistry: (() => void) | undefined;
    let releaseCatalog: (() => void) | undefined;
    mocks.registryList.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseRegistry = resolve; });
      return [{ kind: 'native' }];
    });
    mocks.catalogRead.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseCatalog = resolve; });
      return { catalog: { engines: [] } };
    });

    let handler: ((event: unknown, request: { action: string }) => Promise<unknown>) | undefined;
    registerAgentEngineHandlers({
      handle: vi.fn((_domain, nextHandler) => { handler = nextHandler; }),
    } as never);

    let settled = false;
    const response = handler?.({}, { action: 'detect' }).finally(() => { settled = true; });
    expect(mocks.registryInvalidate).toHaveBeenCalledTimes(1);
    expect(mocks.catalogInvalidate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(mocks.registryList).toHaveBeenCalledTimes(1);
      expect(mocks.catalogRead).toHaveBeenCalledTimes(1);
    });

    releaseRegistry?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCatalog?.();

    await expect(response).resolves.toMatchObject({
      success: true,
      data: [{ kind: 'native' }],
    });
  });
});
