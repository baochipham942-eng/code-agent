// 链路级撤回验证（N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE）：停车审批发出过
// 「有操作等你确认」needs-input 通知后，裁决一旦落定（approve / deny / timeout），
// host 必须在同一 NOTIFICATION_SHOW 通道广播一条带 retract 标记、携带原 dedupeKey
// 的事件，renderer 才能把「离开期间的提醒」队列里那条过期提醒收掉。
// 用真实 notificationService 单例 + 真实 OrchestratorPermissionIsland 串起来；
// 没投递过的键（策略外/从未通知的请求 id）不得广播任何撤回。
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

/** 停车一条无人值守审批，等到 needs-input 通知 + permission_request 事件都落地。 */
async function parkOne(island: OrchestratorPermissionIsland, sessionId: string, onEvents: AgentEvent[]) {
  const result = island.requestPermission({
    type: 'file_write',
    tool: 'write_file',
    details: { path: `/tmp/${sessionId}.txt` },
    sessionId,
  });
  // 无人值守 file_write 先过写授权查询（动态 import + 会话查询）才落停车——fake timers
  // 下 setImmediate 被冻，用微任务自旋排空（同 parkedApprovalNeedsInputDedupe 的做法）。
  for (let i = 0; i < 40 && onEvents.length === 0; i += 1) await Promise.resolve();
  expect(onEvents).toHaveLength(1);
  const requestId = (onEvents[0] as { data?: { id?: string } }).data?.id;
  expect(requestId).toBeTruthy();
  return { result, requestId: requestId! };
}

describe('停车审批 needs-input 通知撤回（真服务链路）', () => {
  let island: OrchestratorPermissionIsland;
  let onEvents: AgentEvent[];
  let persistence: Array<Promise<void>>;

  beforeEach(() => {
    resetPermissionModeManager();
    vi.useFakeTimers();
    platformMocks.focusedWindow = {};
    platformMocks.broadcast.mockClear();
    notificationService.clearRecentNotifications();
    onEvents = [];
    persistence = [];
    island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: (event) => {
        onEvents.push(event);
        persistence.push(persistTaskManagerEvent(makeDeps(), 'retract-chain', event));
      },
      injectedPendingApprovalRepo: makeRepo(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
    notificationService.clearRecentNotifications();
  });

  async function parkInIsland(sessionId: string) {
    return parkOne(island, sessionId, onEvents);
  }

  it('approve 赢得裁决 → 一条 retract 广播，dedupeKey === 请求 id', async () => {
    const sessionId = 'retract-approve';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const { result, requestId } = await parkInIsland(sessionId);

    // 投递了停车口的「有操作等你确认」（第二个落库口同键被去重）。
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '有操作等你确认', urgent: true, dedupeKey: requestId }),
    );

    expect(island.resolveParkedApproval(requestId, 'allow')).toBe(true);
    await expect(result).resolves.toEqual({ approved: true, approvalSource: 'user' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(platformMocks.broadcast).toHaveBeenLastCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ retract: true, dedupeKey: requestId }),
    );
  });

  it('deny 赢得裁决 → 同样一条 retract 广播', async () => {
    const sessionId = 'retract-deny';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const { result, requestId } = await parkInIsland(sessionId);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);

    expect(island.resolveParkedApproval(requestId, 'deny')).toBe(true);
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'user' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(platformMocks.broadcast).toHaveBeenLastCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ retract: true, dedupeKey: requestId }),
    );
  });

  it('unattended 60s 超时 → 超时路径也撤回', async () => {
    const sessionId = 'retract-timeout';
    getPermissionModeManager().markUnattendedSession(sessionId);
    getPermissionModeManager().markUnattendedApprovalTerminal(sessionId);
    const { result, requestId } = await parkInIsland(sessionId);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({ approved: false, denialSource: 'timeout' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(platformMocks.broadcast).toHaveBeenLastCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ retract: true, dedupeKey: requestId }),
    );
  });

  it('裁决没赢的 id 不广播：未知 id 与已裁决过的第二条都静默', async () => {
    const sessionId = 'retract-unknown';
    getPermissionModeManager().markUnattendedSession(sessionId);
    const { result, requestId } = await parkInIsland(sessionId);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);

    // 从未停车/从未通知的 id：没赢也没投递，什么都不广播。
    expect(island.resolveParkedApproval('never-notified-id', 'allow')).toBe(false);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);

    // 第一口赢后，第二口（抢答）不得再广播第二条撤回。
    expect(island.resolveParkedApproval(requestId, 'deny')).toBe(true);
    expect(island.resolveParkedApproval(requestId, 'deny')).toBe(false);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toEqual({ approved: false, denialSource: 'user' });
  });
});

describe('resolved permission_request 事件的撤回（落库口）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    platformMocks.focusedWindow = {};
    platformMocks.broadcast.mockClear();
    notificationService.clearRecentNotifications();
  });

  afterEach(() => {
    vi.useRealTimers();
    notificationService.clearRecentNotifications();
  });

  const plainRequest = (id: string, sessionId: string, resolved?: boolean): AgentEvent => ({
    type: 'permission_request' as const,
    data: {
      id,
      sessionId,
      type: 'file_write',
      tool: 'write_file',
      details: { path: `/tmp/${id}.txt` },
      timestamp: 1,
      ...(resolved ? { resolved: true as const, decision: 'timeout' as const } : {}),
    },
  });

  it('已投递的 needs-input 收到 resolved 事件 → 一条 retract 广播', async () => {
    const deps = makeDeps();
    await persistTaskManagerEvent(deps, 'plain-retract', plainRequest('plain-r1', 'plain-retract'));
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '需要授权', urgent: true, dedupeKey: 'plain-r1' }),
    );

    await persistTaskManagerEvent(deps, 'plain-retract', plainRequest('plain-r1', 'plain-retract', true));
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(platformMocks.broadcast).toHaveBeenLastCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ retract: true, dedupeKey: 'plain-r1' }),
    );
  });

  it('从未投递过的 id 收到 resolved 事件 → 不广播任何撤回', async () => {
    const deps = makeDeps();
    await persistTaskManagerEvent(deps, 'plain-never', plainRequest('never-notified', 'plain-never', true));
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });
});
