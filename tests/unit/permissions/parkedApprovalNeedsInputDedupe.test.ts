// 链路级去重验证：停车审批的 needs-input 通知有两个发送口——
// ① parkApproval 里的 notifyNeedsInput（「去收件箱确认」文案，先发）
// ② permission_request 事件经 persistTaskManagerEvent 的 notifyNeedsInput（「需要授权」文案）
// 两者用真实 notificationService 单例 + 真实 OrchestratorPermissionIsland 串起来，
// 断言同一条停车请求只投递一条横幅；普通（非停车）请求经 ② 仍各投递一条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  broadcast: vi.fn(),
}));

const sessionManagerStub = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => platformMocks.focusedWindow },
  broadcastToRenderer: platformMocks.broadcast,
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
// notifyTaskResuming 的文案语言读 configService（ui.language）；本文件不测该路径，钉死 zh。
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
// persistTaskManagerEvent / backgroundTaskTerminal 从 services barrel 拿
// { getSessionManager, notificationService }——sessionManager 打桩，notificationService 用真件。
vi.mock('../../../src/host/services', async () => {
  const real = await import('../../../src/host/services/infra/notificationService');
  return {
    getSessionManager: () => sessionManagerStub,
    notificationService: real.notificationService,
  };
});

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { notificationService } from '../../../src/host/services/infra/notificationService';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeRepo(): PendingApprovalRepository {
  return {
    insert: vi.fn(),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository;
}

function makeDeps() {
  return {
    turnStateBySession: new Map(),
    backgroundPermissionOwners: new Map(),
    backgroundRunTerminalErrors: new Map(),
    messageDeltaAccumulator: new MessageDeltaAccumulator(),
  };
}

describe('停车审批 needs-input 横幅去重（真服务链路）', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
    platformMocks.focusedWindow = {};
    platformMocks.broadcast.mockClear();
    notificationService.clearRecentNotifications();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    notificationService.clearRecentNotifications();
  });

  it('同一条停车审批只投递一条 needs-input 横幅（停车口先发，落库口同键被去重）', async () => {
    const sessionId = 'parked-dedupe-chain';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const deps = makeDeps();
    const persistence: Array<Promise<void>> = [];
    const onEvents: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: (event) => {
        onEvents.push(event);
        persistence.push(persistTaskManagerEvent(deps, sessionId, event));
      },
      injectedPendingApprovalRepo: makeRepo(),
    });

    const result = island.requestPermission({
      type: 'file_write',
      tool: 'write_file',
      details: { path: '/tmp/parked-dedupe.txt' },
      sessionId,
    });
    await Promise.all(persistence);

    expect(onEvents).toHaveLength(1);
    expect(onEvents[0]).toMatchObject({ type: 'permission_request' });
    // 两个发送口只放出一条：先到的停车口文案（更具体的「去收件箱确认」）。
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '有操作等你确认', sessionId, urgent: true }),
    );

    // 收尾：解除停车 promise（同时清掉 24h backstop 定时器），不留悬挂句柄。
    const requestId = (onEvents[0] as { data?: { id?: string } }).data?.id;
    expect(requestId).toBeTruthy();
    expect(island.handlePermissionResponse(requestId!, 'deny')).toBe('delivered');
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'user' });
  });

  it('普通（非停车）permission_request 经落库口仍各投递一条，不被去重误伤', async () => {
    const sessionId = 'plain-permission-dedupe';
    const deps = makeDeps();
    await persistTaskManagerEvent(deps, sessionId, {
      type: 'permission_request',
      data: {
        id: 'plain-req-1',
        sessionId,
        type: 'file_write',
        tool: 'write_file',
        details: { path: '/tmp/plain-1.txt' },
        timestamp: 1,
      },
    });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '需要授权', sessionId, urgent: true }),
    );

    await persistTaskManagerEvent(deps, sessionId, {
      type: 'permission_request',
      data: {
        id: 'plain-req-2',
        sessionId,
        type: 'file_write',
        tool: 'write_file',
        details: { path: '/tmp/plain-2.txt' },
        timestamp: 2,
      },
    });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
  });
});
