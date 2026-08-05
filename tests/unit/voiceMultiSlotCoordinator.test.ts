import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/shared/contract/agent';
import type { VoiceWorkItem, VoiceWorkNarration } from '../../src/shared/contract/voice';

type TaskEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: TaskEvent) => void>(),
  observers: new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>(),
  startBackgroundTask: vi.fn<(
    taskId: string,
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: unknown,
    metadata?: unknown,
  ) => Promise<void>>(async () => undefined),
  cancelBackgroundTask: vi.fn<(taskId: string) => Promise<boolean>>(async () => true),
  interruptBackgroundTask: vi.fn<(
    taskId: string,
    message: string,
    attachments?: unknown[],
    options?: unknown,
  ) => Promise<{ outcome: 'steered' }>>(async () => ({ outcome: 'steered' as const })),
  promptUserInChat: vi.fn<(request: unknown) => Promise<{ status: 'timeout' }>>(
    async () => ({ status: 'timeout' as const }),
  ),
  emit(type: string, taskId: string, data: Record<string, unknown> = {}) {
    for (const listener of this.listeners) {
      listener({ type, sessionId: 'session-1', data: { ...data, taskId } });
    }
  },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: TaskEvent) => void) => runtime.listeners.add(listener),
    off: (_event: string, listener: (event: TaskEvent) => void) => runtime.listeners.delete(listener),
    observeAgentEvents: (observer: (sessionId: string, event: AgentEvent, taskId?: string) => void) => {
      runtime.observers.add(observer);
      return () => runtime.observers.delete(observer);
    },
    startBackgroundTask: runtime.startBackgroundTask,
    cancelBackgroundTask: runtime.cancelBackgroundTask,
    interruptBackgroundTask: runtime.interruptBackgroundTask,
  }),
}));
vi.mock('../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: runtime.promptUserInChat,
}));
vi.mock('../../src/host/services/voice/voiceWorkEvidence', () => ({
  resolveVoiceWorkOutcome: vi.fn(async () => 'done'),
}));
vi.mock('../../src/host/services/voice/voiceTaskResultProjector', () => ({
  projectVoiceTaskTerminalResult: vi.fn(async () => undefined),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => null),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: vi.fn(async () => ({ messages: [] })) }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({ getConnectorRegistry: () => ({ get: () => undefined }) }));

const { beginVoiceDispatch, dispatchVoiceIntent, endVoiceDispatch, pushVoiceTranscript } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');

let workItems: VoiceWorkItem[];
let narrations: VoiceWorkNarration[];

function spawn(index: number, laneKey = `lane-${index}`, submissionKey = `turn-${index}`) {
  return dispatchVoiceIntent({
    kind: 'spawn_task',
    title: `任务${index}`,
    shortName: `短名${index}`,
    laneKey,
    submissionKey,
    prompt: `执行任务${index}`,
  });
}

function latest(id: string): VoiceWorkItem | undefined {
  return [...workItems].reverse().find((item) => item.id === id);
}

beforeEach(() => {
  endVoiceDispatch();
  runtime.listeners.clear();
  runtime.observers.clear();
  runtime.startBackgroundTask.mockClear();
  runtime.cancelBackgroundTask.mockClear();
  runtime.interruptBackgroundTask.mockClear();
  runtime.promptUserInChat.mockClear();
  workItems = [];
  narrations = [];
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: (item) => workItems.push(item),
    onWorkFailed: () => undefined,
    onWorkNarration: (narration) => narrations.push(narration),
    onEndCall: () => undefined,
  });
});

describe('voice multi-slot coordinator', () => {
  it('starts two different lanes in parallel', async () => {
    pushVoiceTranscript({ role: 'user', text: '同时派两件需要澄清的活。' });
    await spawn(1);
    await spawn(2);

    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2);
    const ids = runtime.startBackgroundTask.mock.calls.map((call) => call[0] as string);
    expect(latest(ids[0])).toMatchObject({ shortName: '短名1', status: 'running' });
    expect(latest(ids[1])).toMatchObject({ shortName: '短名2', status: 'running' });
    expect(JSON.stringify(runtime.startBackgroundTask.mock.calls[0][4]))
      .toContain('需要澄清时调用 AskUserQuestion');
  });

  it('serializes the same lane until the first task settles', async () => {
    await spawn(1, 'report');
    await spawn(2, 'report');
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const queued = workItems.find((item) => item.shortName === '短名2');
    expect(queued).toMatchObject({ status: 'queued' });

    runtime.emit('task_completed', firstId);
    await vi.waitFor(() => expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2));
    expect(runtime.startBackgroundTask.mock.calls[1][0]).toBe(queued?.id);
  });

  it('reuses a duplicate submission key', async () => {
    await spawn(1, 'report', 'same-turn');
    const reply = await spawn(2, 'other', 'same-turn');

    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    expect(reply).toContain('reused');
  });

  it('cancels one task by short name without touching its sibling', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const secondId = runtime.startBackgroundTask.mock.calls[1][0] as string;

    await dispatchVoiceIntent({ kind: 'cancel_task', target: '短名1' });

    expect(runtime.cancelBackgroundTask).toHaveBeenCalledWith(firstId);
    expect(runtime.cancelBackgroundTask).not.toHaveBeenCalledWith(secondId);
    expect(latest(secondId)).toMatchObject({ status: 'running' });
  });

  it('asks a voice-rendered question when the target is ambiguous', async () => {
    await spawn(1);
    await spawn(2);

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task' });

    expect(runtime.cancelBackgroundTask).not.toHaveBeenCalled();
    expect(runtime.promptUserInChat).toHaveBeenCalledOnce();
    expect(reply).toContain('AskUserQuestion');
  });

  it('deduplicates terminal events per task and prefixes each result with its short name', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const secondId = runtime.startBackgroundTask.mock.calls[1][0] as string;
    runtime.emit('task_completed', firstId);
    runtime.emit('task_completed', firstId);
    runtime.emit('task_completed', secondId);

    await vi.waitFor(() => expect(narrations.filter((item) => item.status === 'done')).toHaveLength(2));
    expect(narrations.filter((item) => item.status === 'done').map((item) => item.title)).toEqual([
      '短名1',
      '短名2',
    ]);
  });
});
