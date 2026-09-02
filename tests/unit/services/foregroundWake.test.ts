import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  createForegroundWake,
  type ForegroundWakeDependencies,
} from '../../../src/host/services/commandCenter/foregroundWake';
import { WAKE_NOOP_TOOL_NAME } from '../../../src/shared/constants/agent';
import { SESSION_COMMAND_CENTER_BRAIN_CONTEXT } from '../../../src/host/app/sessionCommandCenterBrain';
import { MAX_CONSECUTIVE_WAKES } from '../../../src/shared/constants/sessionCommandCenter';

const sendMessage = vi.fn().mockResolvedValue(undefined);
const orchestrator = {
  isProcessing: vi.fn(() => false),
  sendMessage,
};
const manager = {
  getSessionState: vi.fn(() => ({ status: 'idle' })),
  getWaitingQueue: vi.fn((): string[] => []),
  hasActivePrimaryRun: vi.fn(() => false),
  getOrCreateCurrentOrchestrator: vi.fn(() => orchestrator),
  setSessionContext: vi.fn(),
  setWorkingDirectory: vi.fn(),
};
const wakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};
const session = {
  id: 'session-a',
  title: '会话',
  modelConfig: { provider: 'openai', model: 'test' },
  type: 'chat' as const,
  workingDirectory: '/tmp/project',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'user-1', role: 'user' as const, content: '开始', timestamp: 1 }],
  todos: [],
  messageCount: 1,
};

function task(id = 'task-1'): SessionCommandTask {
  return {
    id,
    sessionId: 'session-a',
    title: '生成报告',
    shortName: '报告',
    laneKey: 'report',
    submissionKey: id,
    prompt: '生成报告',
    workspaceScope: {} as SessionCommandTask['workspaceScope'],
    status: 'completed',
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    summary: '报告已生成。',
  };
}

function dependencies(overrides: Partial<ForegroundWakeDependencies> = {}): ForegroundWakeDependencies {
  return {
    getTaskManager: () => manager as unknown as ReturnType<ForegroundWakeDependencies['getTaskManager']>,
    loadSession: vi.fn(async () => session),
    hasQueuedUserInput: vi.fn(() => false),
    isVoiceSession: vi.fn(() => false),
    logger: wakeLogger,
    ...overrides,
  };
}

describe('foreground task-result wake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue(undefined);
    orchestrator.isProcessing.mockReturnValue(false);
    manager.getSessionState.mockReturnValue({ status: 'idle' });
    manager.getWaitingQueue.mockReturnValue([]);
    manager.hasActivePrimaryRun.mockReturnValue(false);
    manager.getOrCreateCurrentOrchestrator.mockReturnValue(orchestrator);
  });

  it.each(['completed', 'failed'] as const)('wakes for %s with hidden input and the foreground brain tool surface', async (status) => {
    const wake = createForegroundWake(dependencies());

    await wake(task(), status);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [prompt, attachments, options] = sendMessage.mock.calls[0];
    expect(prompt).toContain(status === 'completed' ? '已完成' : '已失败');
    expect(prompt).toContain('报告已生成');
    expect(attachments).toBeUndefined();
    expect(options).toMatchObject({
      mode: 'normal',
      inputHistoryVisibility: 'meta',
      runRegistration: 'auxiliary',
      maxIterations: 4,
    });
    expect(options.historyVisibility).toBeUndefined();
    expect(options.allowedToolNames).toContain(WAKE_NOOP_TOOL_NAME);
    expect(options.turnSystemContext?.join('\n')).toContain('<background_task_hidden_wake>');
    expect(options.turnSystemContext?.join('\n')).toContain(`只调用 ${WAKE_NOOP_TOOL_NAME}`);
    expect(options.turnSystemContext).toContain(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    expect(manager.setSessionContext).toHaveBeenCalledWith('session-a', session.messages);
  });

  it('does not wake a cancelled task', async () => {
    const wake = createForegroundWake(dependencies());
    await wake(task(), 'cancelled');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not wake while the foreground session is busy', async () => {
    manager.hasActivePrimaryRun.mockReturnValue(true);
    const wake = createForegroundWake(dependencies());
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeLogger.info).toHaveBeenCalledWith(
      'Foreground wake skipped: session busy',
      expect.objectContaining({ sessionId: 'session-a' }),
    );
  });

  it('does not wake a live voice session', async () => {
    const wake = createForegroundWake(dependencies({ isVoiceSession: () => true }));
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeLogger.info).toHaveBeenCalledWith(
      'Foreground wake skipped: voice session',
      expect.objectContaining({ sessionId: 'session-a' }),
    );
  });

  it('does not wake when a durable user input is queued', async () => {
    const wake = createForegroundWake(dependencies({ hasQueuedUserInput: () => true }));
    await wake(task(), 'completed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('caps consecutive hidden wakes until a new visible user message arrives', async () => {
    const wake = createForegroundWake(dependencies());
    for (let index = 0; index < MAX_CONSECUTIVE_WAKES + 1; index += 1) {
      await wake(task(`task-${index}`), 'completed');
    }

    expect(sendMessage).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WAKES);
    expect(wakeLogger.warn).toHaveBeenCalledWith(
      'Foreground wake skipped: consecutive wake limit reached',
      expect.objectContaining({ consecutive: MAX_CONSECUTIVE_WAKES }),
    );
  });

  it('propagates orchestrator failure for the settle hook to log without blocking settlement', async () => {
    sendMessage.mockRejectedValueOnce(new Error('model unavailable'));
    const wake = createForegroundWake(dependencies());
    await expect(wake(task(), 'completed')).rejects.toThrow('model unavailable');
  });

  // N-SUBAGENT-INPUT：用户绕过团长直接给任务补过话，收工摘要要带一句让团长汇总时不漏
  it('mentions how many times the user supplemented the task directly', async () => {
    const wake = createForegroundWake(dependencies());
    await wake({ ...task(), userInputCount: 2 }, 'completed');
    expect(sendMessage.mock.calls[0][0]).toContain('期间用户直接给它补了 2 句');

    await wake(task('task-2'), 'completed');
    expect(sendMessage.mock.calls[1][0]).not.toContain('期间用户');
  });
});
