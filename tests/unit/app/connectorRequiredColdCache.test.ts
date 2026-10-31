// ============================================================================
// N-CONNECTOR-POLISH-AUDIT-FU1-FU2：connector_required 卡片的冷缓存回归。
// 真实 cliConnectorStatusCache 模块（不 mock 缓存本体），只 mock 到 CLI driver
// 进程边界：开机后第一轮在 CLI 状态探测落定前/失败时，选中未登录的 feishu
// 不能把「未连接」静默错判成 ready 而吞掉连接卡。
// ============================================================================

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getSessionManager } from '../../../src/host/services';
import {
  getCachedCliConnectorConnectionStatus,
  replaceCliConnectorConnectionStatusCache,
} from '../../../src/host/connectors/cli/cliConnectorStatusCache';

const loggerSpies = vi.hoisted(() => ({ warn: vi.fn() }));
const resolveAgentMock = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  larkStatus: Promise.resolve({ connected: false, identity: 'none' }) as Promise<{
    connected: boolean;
    identity: string;
    stale?: boolean;
  }>,
  larkStatusStarted: false,
}));

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: loggerSpies.warn,
      error: vi.fn(),
    }),
  };
});

// 卡判读前的探测等待缩到测试档；生产值在 shared/constants/timeouts.ts（CONNECTOR_CARD_TIMEOUTS）。
vi.mock('../../../src/shared/constants/timeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants/timeouts')>();
  return {
    ...actual,
    CONNECTOR_CARD_TIMEOUTS: { CLI_STATUS_PROBE_WAIT_MS: 250 },
  };
});

vi.mock('../../../src/host/agent/agentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/agentRegistry')>();
  return { ...actual, resolveAgent: resolveAgentMock };
});
vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));

// CLI driver 是进程边界（真实现会 spawn lark/tmeet CLI 子进程），照
// connector.oauth.ipc.test.ts 的先例 mock 到 driver 一层；被测的缓存模块保持真模块。
vi.mock('../../../src/host/connectors/feishu/larkCli', () => ({
  createLarkCliDriver: () => ({
    status: () => {
      env.larkStatusStarted = true;
      return env.larkStatus;
    },
    connect: vi.fn(),
    cancelConnect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));
vi.mock('../../../src/host/connectors/tmeet/tmeetCli', () => ({
  createTmeetCliDriver: () => ({
    status: vi.fn(async () => ({ connected: false, identity: 'none' })),
    connect: vi.fn(),
    cancelConnect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));
vi.mock('../../../src/host/connectors/oauth/connectorOAuthStore', () => ({
  ConnectorOAuthStore: class {
    tokens() { return undefined; }
    clientSecret() { return undefined; }
    saveClientSecret() {}
    invalidateCredentials() {}
    descriptor() { return undefined; }
    saveDescriptor() {}
  },
}));
vi.mock('../../../src/host/mcp/mcpOAuthConsent', () => ({
  requestMcpOAuthConsent: vi.fn(async () => ({
    granted: true,
    timedOut: false,
    permissionDecision: 'allow',
    permissionDecisionReason: 'allowed',
  })),
  cancelPendingMcpOAuthConsent: vi.fn(() => false),
}));

vi.mock('../../../src/host/services', () => ({ getSessionManager: vi.fn() }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({
    getMessageById: vi.fn(),
    getSessionForkLineage: vi.fn(() => null),
    getSessionForkContextSource: vi.fn(() => null),
  })),
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({ loadStreamSnapshot: vi.fn() }));
vi.mock('../../../src/host/services/checkpoint', () => ({ getFileCheckpointService: vi.fn() }));
vi.mock('../../../src/host/services/commands/promptCommandService', () => ({
  applyPromptCommandExpansion: vi.fn(async (envelope: unknown) => envelope),
}));

import { registerConnectorHandlers, stopConnectorStatusWatcher } from '../../../src/host/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function registerConnectorIpc(): HandlerFn {
  let handler: HandlerFn | undefined;
  const ipcMain = {
    handle: (channel: string, fn: HandlerFn) => {
      if (channel === IPC_DOMAINS.CONNECTOR) handler = fn;
    },
  } as unknown as Parameters<typeof registerConnectorHandlers>[0];
  registerConnectorHandlers(ipcMain, () => null, () => null);
  if (!handler) throw new Error('connector handler was not registered');
  return handler;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('agentAppService.sendMessage → connector_required（真实缓存模块·冷缓存）', () => {
  let taskManager: {
    getOrCreateCurrentOrchestrator: ReturnType<typeof vi.fn>;
    emitAgentEventForSession: ReturnType<typeof vi.fn>;
    startTask: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setSessionContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    replaceCliConnectorConnectionStatusCache([]);
    env.larkStatus = Promise.resolve({ connected: false, identity: 'none' });
    env.larkStatusStarted = false;
    resolveAgentMock.mockReset();
    taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({
        setWorkingDirectory: vi.fn(),
        getWorkingDirectory: vi.fn(() => '/tmp/ws'),
      })),
      emitAgentEventForSession: vi.fn(),
      startTask: vi.fn(async () => undefined),
      cleanup: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
    };
    vi.mocked(getSessionManager).mockReturnValue({
      getSession: vi.fn(async () => ({ id: 'session-1', workingDirectory: '/tmp/ws' })),
      getSessionMetadata: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as never);
  });

  afterAll(() => {
    stopConnectorStatusWatcher();
  });

  function createService(): AgentAppServiceImpl {
    return new AgentAppServiceImpl(() => taskManager as never, () => null, () => 'session-1', vi.fn());
  }

  function connectorRequiredCalls() {
    return taskManager.emitAgentEventForSession.mock.calls.filter(([, event]) => event.type === 'connector_required');
  }

  it('gap (a)：选中 feishu、探测仍在途 → 探测落定后本轮恰好发一次 connector_required（冷缓存不再吞卡）', async () => {
    const probe = deferred<{ connected: boolean; identity: string }>();
    env.larkStatus = probe.promise;
    const handler = registerConnectorIpc();
    void handler(null, { action: 'oauthStatus' } as IPCRequest).catch(() => undefined);
    await vi.waitFor(() => expect(env.larkStatusStarted).toBe(true));
    // 前提钉死：此刻轮级缓存确实是冷的（探测仍在途）
    expect(getCachedCliConnectorConnectionStatus('feishu')).toBeUndefined();

    const turn = createService().sendMessage({
      sessionId: 'session-1',
      content: '用飞书给我发一条消息',
      context: { selectedConnectorIds: ['feishu'] },
    });
    // 探测在轮次进行中才落定：未登录（connected:false）
    probe.resolve({ connected: false, identity: 'none' });
    await turn;

    const calls = connectorRequiredCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      type: 'connector_required',
      data: { connectors: [{ id: 'feishu', source: 'selected', reason: 'not_connected' }] },
    });
  });

  it('gap (a)-timeout：探测一直不落定 → 有界等待后 fail-open（不发卡、不卡死轮次），warn 出 probe timeout', async () => {
    const probe = deferred<{ connected: boolean; identity: string }>();
    env.larkStatus = probe.promise;
    const handler = registerConnectorIpc();
    void handler(null, { action: 'oauthStatus' } as IPCRequest).catch(() => undefined);
    await vi.waitFor(() => expect(env.larkStatusStarted).toBe(true));

    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { selectedConnectorIds: ['feishu'] },
    });

    expect(connectorRequiredCalls()).toHaveLength(0);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('CLI connector status probe unresolved'),
      expect.objectContaining({ probeOutcome: 'timeout' }),
    );
    probe.resolve({ connected: false, identity: 'none' });
  });

  it('gap (b)：探测持续失败 → 不发卡（fail-open）但 warn 出可区分的 probe error', async () => {
    const rejection = Promise.reject(new Error('lark-cli exploded'));
    void rejection.catch(() => undefined); // 防未处理拒绝噪音；探测消费的是同一个 promise
    env.larkStatus = rejection;
    const handler = registerConnectorIpc();
    await handler(null, { action: 'oauthStatus' } as IPCRequest).catch(() => undefined);
    // 失败的探测不填轮级缓存
    expect(getCachedCliConnectorConnectionStatus('feishu')).toBeUndefined();

    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { selectedConnectorIds: ['feishu'] },
    });

    expect(connectorRequiredCalls()).toHaveLength(0);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('CLI connector status probe unresolved'),
      expect.objectContaining({ probeOutcome: 'error' }),
    );
  });

  it('缓存已暖且已连上 → 不发卡', async () => {
    replaceCliConnectorConnectionStatusCache([{ id: 'feishu', connected: true }]);
    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { selectedConnectorIds: ['feishu'] },
    });
    expect(connectorRequiredCalls()).toHaveLength(0);
    expect(taskManager.startTask).toHaveBeenCalled();
  });

  it('没选连接器 → 不发卡且零额外探测（driver 不被调）', async () => {
    await createService().sendMessage({ sessionId: 'session-1', content: 'hi', context: {} });
    expect(connectorRequiredCalls()).toHaveLength(0);
    expect(env.larkStatusStarted).toBe(false);
  });
});
