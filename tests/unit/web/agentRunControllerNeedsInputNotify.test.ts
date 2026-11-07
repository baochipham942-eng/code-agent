// ============================================================================
// AgentRunController 前台 permission_request 的 needs-input 横幅
// （N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU3-FU1）
//
// 前台桌面路由（/api/agent/run）的审批事件此前只走 SSE，没有任何通知出口：
// 用户切到别的会话/收起聊天列时，审批卡挂在屏幕外无人知晓（TaskManager 落库口
// 只覆盖后台任务）。emitAgentEvent 现在给未决 permission_request 发
// notificationService.notifyNeedsInput，dedupeKey = 请求 id——同一条请求从停车口/
// 落库口/这里多路到达时，真服务的同键去重只投一条横幅。
// resolved:true 收口事件（超时/被顶替/companion 应答）只经此出口，落库口看不见：
// 这里必须像落库口（taskManagerEventPersistence）一样按 id 撤回已投递的横幅，
// 否则用户回来还会被一条指向已失效审批的「需要授权」补提醒误导。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AgentEvent } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  broadcast: vi.fn(),
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
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');
const { notificationService } = await import('../../../src/host/services/infra/notificationService');

function createSink(): Response {
  return {
    writableEnded: false,
    destroyed: false,
    write: () => true,
    end: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Response;
}

function createController(sessionId = 'session-fg-1') {
  return new AgentRunController({
    res: createSink(),
    runId: 'run-1',
    sessionId,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
  });
}

// 控制器对 permission_request.data 做防御性宽读（顶层 id/tool/command/resolved），
// 测试 payload 按同样的松形状构造，但保留 data 的必需成员（details/timestamp）：
// 断言 as AgentEvent 要求 payload 与联合成员可比，缺必需的 details 会让两个方向
// 都不可比（tsc-tests 棘轮 TS2352）。overrides 用具体可选字段而非
// Record<string, unknown>——展开后者会把 data.type 撑宽成 string 并注入 unknown
// 索引签名，同样破坏可比性。
type PermissionRequestOverrides = {
  id?: string;
  command?: string;
  resolved?: boolean;
  decision?: string;
};

function permissionRequest(overrides: PermissionRequestOverrides = {}): AgentEvent {
  return {
    type: 'permission_request',
    data: {
      id: 'perm-req-1',
      type: 'command',
      tool: 'bash',
      command: 'npm test',
      timestamp: 1,
      details: { command: 'npm test' },
      ...overrides,
    },
  } as AgentEvent;
}

describe('AgentRunController 前台 needs-input 横幅', () => {
  beforeEach(() => {
    platformMocks.focusedWindow = {};
    platformMocks.broadcast.mockClear();
    notificationService.clearRecentNotifications();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    notificationService.clearRecentNotifications();
  });

  it('未决 permission_request → 恰好一次 notifyNeedsInput（dedupeKey = data.id，文案同落库口）', () => {
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    createController('session-fg-1').emitAgentEvent(permissionRequest());

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: 'session-fg-1',
      title: '需要授权',
      body: 'bash: npm test',
      dedupeKey: 'perm-req-1',
    });
    // 事件本身照常进 SSE，横幅只是旁路。
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
  });

  it('同一请求 id 两次到达 → 真通知服务同键去重只投一条；不同 id 各投一条', () => {
    // 不打桩 notifyNeedsInput：走真 notificationService 的 deliveredNeedsInputKeys 去重。
    const controller = createController('session-fg-dedupe');
    controller.emitAgentEvent(permissionRequest({ id: 'perm-req-dup' }));
    controller.emitAgentEvent(permissionRequest({ id: 'perm-req-dup', command: undefined }));

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '需要授权', sessionId: 'session-fg-dedupe', urgent: true }),
    );

    controller.emitAgentEvent(permissionRequest({ id: 'perm-req-other' }));
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
  });

  it('resolved:true（超时/被取代/companion 收口）→ 不通知', () => {
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    createController().emitAgentEvent(permissionRequest({ resolved: true, decision: 'timeout' }));

    expect(notify).not.toHaveBeenCalled();
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });

  it('已投递的请求收口（resolved:true）→ 按原 id 撤回已投递横幅（retract 广播恰一次）', () => {
    const retract = vi.spyOn(notificationService, 'retractNeedsInput');
    const controller = createController('session-fg-retract');
    // 先按未决事件投递（走真服务，deliveredNeedsInputKeys 记账）。
    controller.emitAgentEvent(permissionRequest({ id: 'perm-req-resolve' }));
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    platformMocks.broadcast.mockClear();

    // 同 id 收口：撤回——错过横幅的用户回来不再收到指向已失效审批的补提醒。
    controller.emitAgentEvent(permissionRequest({ id: 'perm-req-resolve', resolved: true, decision: 'timeout' }));

    expect(retract).toHaveBeenCalledTimes(1);
    expect(retract).toHaveBeenCalledWith('perm-req-resolve');
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ retract: true, dedupeKey: 'perm-req-resolve' }),
    );
  });

  it('收口的 id 从未投递过 → 撤回是 no-op，不广播', () => {
    const retract = vi.spyOn(notificationService, 'retractNeedsInput');
    createController().emitAgentEvent(permissionRequest({ resolved: true, decision: 'superseded' }));

    expect(retract).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });

  it('撤回口抛错也不许打断事件主链路（emitAgentEvent 照常返回 true 并写 SSE）', () => {
    vi.spyOn(notificationService, 'retractNeedsInput').mockImplementation(() => {
      throw new Error('retract exploded');
    });
    const controller = createController();
    const emitted = controller.emitAgentEvent(permissionRequest({ resolved: true, decision: 'timeout' }));

    expect(emitted).toBe(true);
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });

  it('缺 id 或非 permission_request 事件 → 不通知', () => {
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput');
    const controller = createController();
    controller.emitAgentEvent({ type: 'permission_request', data: { tool: 'bash' } } as AgentEvent);
    controller.emitAgentEvent({ type: 'turn_end', data: {} } as AgentEvent);

    expect(notify).not.toHaveBeenCalled();
  });

  it('通知口抛错不许打断事件主链路（emitAgentEvent 照常返回 true 并写 SSE）', () => {
    const notify = vi.spyOn(notificationService, 'notifyNeedsInput').mockImplementation(() => {
      throw new Error('notification exploded');
    });
    const controller = createController();
    const emitted = controller.emitAgentEvent(permissionRequest());

    expect(emitted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });
});
