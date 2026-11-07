import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAction,
  CronJobAction,
  CronJobDefinition,
} from '../../../src/shared/contract/cron';

const dbState = vi.hoisted(() => ({
  savedRows: [] as unknown[][],
}));

const automationState = vi.hoisted(() => ({
  upsert: vi.fn(),
}));

const agentState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getMessages: vi.fn(),
  setExecutionTopology: vi.fn(),
  cancel: vi.fn(async () => undefined),
  setWorkingDirectory: vi.fn(),
  cleanup: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 1, lastInsertRowid: 0 };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
    getSettings: () => ({
      model: {
        provider: 'openai',
        model: 'gpt-test',
        temperature: 0.2,
      },
    }),
  }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: vi.fn(async () => null),
    createSession: agentState.createSession,
  }),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      sendMessage: agentState.sendMessage,
      getMessages: agentState.getMessages,
      setExecutionTopology: agentState.setExecutionTopology,
      cancel: agentState.cancel,
    }),
    setWorkingDirectory: agentState.setWorkingDirectory,
    cleanup: agentState.cleanup,
  }),
}));

import { CronService } from '../../../src/host/cron/cronService';

interface CronServiceHarness {
  jobs: Map<string, { definition: CronJobDefinition }>;
  executeAction(
    definition: CronJobDefinition,
    action: CronJobAction,
    timeout?: number,
    executionId?: string,
  ): Promise<unknown>;
}

function makeDefinition(context?: Record<string, unknown>): CronJobDefinition {
  const action: AgentAction = {
    type: 'agent',
    agentType: 'default',
    prompt: '检查网页',
    ...(context ? { context } : {}),
  };
  return {
    id: 'job-agent-snapshot',
    runsOn: 'local',
    name: '网页更新提醒',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action,
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function assistantMessage(content: string) {
  return {
    id: 'assistant-final',
    role: 'assistant' as const,
    content,
    timestamp: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.savedRows = [];
  agentState.sendMessage.mockResolvedValue('agent-result');
  agentState.getMessages.mockReturnValue([]);
  agentState.createSession.mockResolvedValue({
    id: 'cron-session-1',
    workingDirectory: undefined,
  });
});

/** 模拟慢 run：被取消后仍会「正常」resolve（真实 loop 取消后也可能如此）。 */
function slowRun(durationMs: number) {
  agentState.sendMessage.mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve('late-result'), durationMs);
  }));
}

function agentJob(agentType = 'default'): CronJobDefinition {
  const base = makeDefinition();
  return { ...base, action: { ...(base.action as AgentAction), agentType } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CronService agent action timeout', () => {
  it('timeout 1000ms + 5s run: cancels the run and fails with the limit in the message', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const definition = agentJob();
    const harness = service as unknown as CronServiceHarness;
    harness.jobs.set(definition.id, { definition });
    slowRun(5000);

    const outcome = harness.executeAction(definition, definition.action, 1000, 'execution-timeout').then(
      () => ({ status: 'completed' as const }),
      (error: Error & { cronSessionId?: string }) => ({ status: 'failed' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const settled = await outcome;

    expect(settled.status).toBe('failed');
    expect((settled as { error: Error }).error.message).toBe('Cron job run exceeded its 1s time limit.');
    expect((settled as { error: { cronSessionId?: string } }).error.cronSessionId).toBe('cron-session-1');
    expect(agentState.cancel).toHaveBeenCalledTimes(1);
    expect(agentState.cleanup).toHaveBeenCalledWith('cron-session-1');
    // 取消后 5s 的假 run 即使自行 resolve，也不会触发第二次模型调用或把任务算成功。
    await vi.advanceTimersByTimeAsync(5000);
    expect(agentState.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 60000, 0, -5, Number.NaN])('timeout %s is treated as unlimited', async (timeout) => {
    vi.useFakeTimers();
    const service = new CronService();
    const definition = agentJob();
    const harness = service as unknown as CronServiceHarness;
    harness.jobs.set(definition.id, { definition });
    slowRun(120_000);
    agentState.getMessages.mockReturnValue([assistantMessage('done')]);

    const outcome = harness.executeAction(definition, definition.action, timeout, 'execution-unlimited');
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(outcome).resolves.toBeDefined();
    expect(agentState.cancel).not.toHaveBeenCalled();
  });

  it('a run that finishes inside the limit completes and leaves no pending timer', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const definition = agentJob();
    const harness = service as unknown as CronServiceHarness;
    harness.jobs.set(definition.id, { definition });
    agentState.getMessages.mockReturnValue([assistantMessage('done')]);

    await harness.executeAction(definition, definition.action, 30_000, 'execution-fast');

    expect(agentState.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('CronService agentType validation at save', () => {
  const baseJob = (agentType: string) => ({
    name: 'job', scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 1, unit: 'days' as const },
    action: { type: 'agent' as const, agentType, prompt: 'p' },
    enabled: false, runsOn: 'local' as const,
  });

  it.each(['default', 'heartbeat', 'dream', 'distill'])('create accepts %s', async (agentType) => {
    await expect(new CronService().createJob(baseJob(agentType))).resolves.toMatchObject({ action: { agentType } });
  });

  it('create rejects an unknown agentType naming the value and the valid ones', async () => {
    await expect(new CronService().createJob(baseJob('abc'))).rejects.toThrow(/“abc”.*default、heartbeat、dream、distill/);
  });

  it('update rejects a changed unknown agentType, accepts a valid change, and tolerates an unchanged legacy value', async () => {
    const service = new CronService();
    const job = await service.createJob(baseJob('default'));
    const action = job.action as AgentAction;
    await expect(service.updateJob(job.id, { action: { ...action, agentType: 'abc' } })).rejects.toThrow(/“abc”/);
    await expect(service.updateJob(job.id, { action: { ...action, agentType: 'heartbeat' } })).resolves.toBeTruthy();

    // 存量行带非法 agentType（直接塞进内存表，模拟 DB 读回）：原样重发旧动作不能被拒。
    const harness = service as unknown as CronServiceHarness;
    const legacy = { ...job, id: 'legacy-job', action: { ...action, agentType: 'legacy-label' } };
    harness.jobs.set(legacy.id, { definition: legacy });
    await expect(service.updateJob(legacy.id, { action: { ...legacy.action, prompt: 'new prompt' } })).resolves.toBeTruthy();
  });
});
