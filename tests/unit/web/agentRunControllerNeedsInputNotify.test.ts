// ============================================================================
// AgentRunController 前台 permission_request 的 needs-input 横幅
// （N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU3-FU1）
//
// 前台桌面路由（/api/agent/run）的审批事件此前只走 SSE，没有任何通知出口：
// 用户切到别的会话/收起聊天列时，审批卡挂在屏幕外无人知晓（TaskManager 落库口
// 只覆盖后台任务）。emitAgentEvent 现在给未决 permission_request 发
// notificationService.notifyNeedsInput，dedupeKey = 请求 id——同一条请求从停车口/
// 落库口/这里多路到达时，真服务的同键去重只投一条横幅。
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

function permissionRequest(overrides: Record<string, unknown> = {}): AgentEvent {
  return {
    type: 'permission_request',
    data: {
      id: 'perm-req-1',
      type: 'command',
      tool: 'bash',
      command: 'npm test',
      timestamp: 1,
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
