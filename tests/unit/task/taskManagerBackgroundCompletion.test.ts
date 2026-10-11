// N-RUNINPUT-TOBACKGROUND-OPTION：run 终点（task_complete）对后台会话的收口。
// BackgroundTaskManager.markCompleted 此前无产线调用方（只有 dev 路由）：后台面板条目
// 永远停在 running、完成通知被焦点门吞掉。这里钉死 TaskManager 的最小接线。
// 2026-10-11 rework：只认 task_complete 不够——失败/取消/中断/max-step 撞顶轮没有
// 收尾文本，条目 spinner 永挂（无槽验收实测 12/22 分钟）。补 agent 终态事件收线
// （error 记账 → agent_complete/agent_cancelled 收口），见 backgroundTaskTerminal.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    updateSession: vi.fn(),
  },
}));

const backgroundManagerState = vi.hoisted(() => ({
  isInBackground: vi.fn(),
  isTaskRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
  notifyNeedsInput: vi.fn(),
}));

const orchestratorMocks = vi.hoisted(() => ({
  configs: [] as Array<{ onEvent: (event: unknown) => Promise<void> }>,
  sendMessage: vi.fn(),
  setSessionId: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    constructor(config: { onEvent: (event: unknown) => Promise<void> }) {
      orchestratorMocks.configs.push(config);
    }
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    setSessionId = (...args: unknown[]) => orchestratorMocks.setSessionId(...args);
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: notifyState,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/host/session/backgroundTaskManager', () => ({
  getBackgroundTaskManager: () => backgroundManagerState,
}));

import { TaskManager } from '../../../src/host/task/TaskManager';

const TASK_COMPLETE_EVENT = {
  type: 'task_complete',
  data: { turnId: 'turn-1', summary: '周报已写好', duration: 4200, toolsUsed: ['Write'] },
} as const;

function newManager(): TaskManager {
  const manager = new TaskManager({ maxConcurrentTasks: 1 });
  manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
  return manager;
}

describe('task_complete 的后台收口（完成通知/面板状态）', () => {
  beforeEach(() => {
    sessionManagerState.getSession.mockReset().mockResolvedValue({
      id: 'session-1',
      title: '长任务',
    });
    backgroundManagerState.isInBackground.mockReset().mockReturnValue(false);
    backgroundManagerState.isTaskRunning.mockReset().mockReturnValue(true);
    backgroundManagerState.markCompleted.mockReset().mockResolvedValue(undefined);
    backgroundManagerState.markFailed.mockReset();
    notifyState.notifyTaskComplete.mockClear();
    dbState.db.updateSession.mockReset();
    orchestratorMocks.configs.length = 0;
  });

  it('后台会话的主 run 完成：交给 markCompleted 收口，不再走普通通知（避免双响）', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(true);
    const manager = newManager();

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', '周报已写好');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
  });

  it('前台会话完成：保持原行为（普通完成通知），不碰后台管理器', async () => {
    const manager = newManager();

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sessionTitle: '长任务',
      summary: '周报已写好',
    }));
  });

  it('子代理的 task_complete（eventKey ≠ sessionId）：不触发后台收口，走原通知路径', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(true);
    const manager = newManager();

    await (manager as unknown as {
      persistEventToSession: (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;
    }).persistEventToSession('session-1', TASK_COMPLETE_EVENT, undefined, 'subagent-key');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(notifyState.notifyTaskComplete).toHaveBeenCalled();
  });
});

describe('agent 终态事件的后台收线（失败/取消/中断/max-step 撞顶轮）', () => {
  type Persist = (sessionId: string, event: unknown, snapshot?: unknown, eventKey?: string) => Promise<void>;

  function getPersist(manager: TaskManager): Persist {
    return (manager as unknown as { persistEventToSession: Persist }).persistEventToSession.bind(manager);
  }

  beforeEach(() => {
    sessionManagerState.getSession.mockReset().mockResolvedValue({
      id: 'session-1',
      title: '长任务',
    });
    backgroundManagerState.isInBackground.mockReset().mockReturnValue(true);
    backgroundManagerState.isTaskRunning.mockReset().mockReturnValue(true);
    backgroundManagerState.markCompleted.mockReset().mockResolvedValue(undefined);
    backgroundManagerState.markFailed.mockReset();
    notifyState.notifyTaskComplete.mockClear();
    orchestratorMocks.configs.length = 0;
  });

  it('撞 max-step 上限（error 事件带稳定 code → agent_complete）：markFailed 收线，传 code 给 renderer 翻译', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markFailed).toHaveBeenCalledWith('session-1', RUN_ERROR_CODE_MAX_ITERATIONS);
    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
  });

  it('失败轮（error 事件带消息 → agent_complete）：markFailed 收原始消息', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'Provider auth failure' },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markFailed).toHaveBeenCalledWith('session-1', 'Provider auth failure');
  });

  it('取消轮（agent_cancelled，无 error）：markCompleted + USER_CANCELLED 标记（不是失败）', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', { type: 'agent_cancelled', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', BACKGROUND_TASK_CANCELLED);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('成功轮（task_complete 已收口）后再到 agent_complete：running-guard 挡住，不双收线', async () => {
    backgroundManagerState.isTaskRunning.mockReturnValue(false); // task_complete 收口后
    const persist = getPersist(newManager());

    await persist('session-1', TASK_COMPLETE_EVENT, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledTimes(1);
    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', '周报已写好');
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('前台轮的 agent_complete：不碰后台管理器', async () => {
    backgroundManagerState.isInBackground.mockReturnValue(false);
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'boom' },
    }, undefined, 'session-1');
    await persist('session-1', { type: 'agent_complete', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).not.toHaveBeenCalled();
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });

  it('子代理的 error（eventKey ≠ sessionId）不记账：主轮随后取消仍按取消收线，不被污染', async () => {
    const persist = getPersist(newManager());

    await persist('session-1', {
      type: 'error',
      data: { message: 'subagent blew up', code: 'SUBAGENT_ERROR' },
    }, undefined, 'subagent-key');
    await persist('session-1', { type: 'agent_cancelled', data: null }, undefined, 'session-1');

    expect(backgroundManagerState.markCompleted).toHaveBeenCalledWith('session-1', BACKGROUND_TASK_CANCELLED);
    expect(backgroundManagerState.markFailed).not.toHaveBeenCalled();
  });
});
