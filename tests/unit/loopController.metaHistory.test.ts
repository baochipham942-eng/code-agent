import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopController } from '../../src/host/loop/loopController';

const orchestratorState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

const sessionManagerState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const ledgerState = vi.hoisted(() => ({
  upsertTask: vi.fn(),
  queueNotification: vi.fn(),
}));

const notificationState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => orchestratorState,
  }),
}));

vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../src/host/tasks/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ledgerState,
}));

vi.mock('../../src/host/services/infra/notificationService', () => ({
  notificationService: notificationState,
}));

vi.mock('../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

async function waitForCall(mock: { mock: { calls: unknown[] } }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('LoopController meta history', () => {
  beforeEach(() => {
    orchestratorState.sendMessage.mockReset();
    sessionManagerState.getSession.mockReset();
    ledgerState.upsertTask.mockReset();
    ledgerState.queueNotification.mockReset();
    notificationState.notifyTaskComplete.mockReset();
    automationState.recordCreated.mockClear();
    automationState.recordEvent.mockClear();
  });

  it('runs loop turns as meta history and disables interactive user questions', async () => {
    sessionManagerState.getSession.mockResolvedValue({
      messages: [{ id: 'a1', role: 'assistant', content: '检查中', timestamp: 2 }],
    });
    orchestratorState.sendMessage.mockResolvedValue(undefined);

    const controller = new LoopController();
    controller.start({
      sessionId: 'session-1',
      prompt: '只回复一句"检查中"',
      maxTurns: 1,
    });

    await waitForCall(orchestratorState.sendMessage);

    expect(orchestratorState.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('只回复一句"检查中"'),
      undefined,
      {
        mode: 'normal',
        historyVisibility: 'meta',
        deniedToolNames: ['AskUserQuestion', 'ask_user_question'],
      },
    );
  });

  it('sends a forced task-complete notification when a loop finishes naturally', async () => {
    sessionManagerState.getSession.mockResolvedValue({
      messages: [{ id: 'a1', role: 'assistant', content: '检查中', timestamp: 2 }],
    });
    orchestratorState.sendMessage.mockResolvedValue(undefined);

    const controller = new LoopController();
    controller.start({
      sessionId: 'session-1',
      prompt: '只回复一句"检查中"',
      maxTurns: 1,
    });

    await waitForCall(notificationState.notifyTaskComplete);

    expect(ledgerState.queueNotification).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      type: 'task_completed',
      title: expect.stringMatching(/^循环 · /),
      message: '已完成 1 轮',
    }));
    expect(notificationState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        sessionTitle: expect.stringMatching(/^循环 · /),
        summary: '已完成 1 轮',
        toolsUsed: [],
        succeeded: true,
      }),
      { force: true },
    );
    expect(automationState.recordCreated).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^loop:/),
      sourceSessionId: 'session-1',
      type: 'loop',
      status: 'running',
    }));
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'completed',
      status: 'completed',
    }));
  });
});
