import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const warn = vi.hoisted(() => vi.fn());

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

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

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
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
  });
});

function cappedJob(maxRunBudget: number): CronJobDefinition {
  return { ...makeDefinition(), maxRunBudget };
}

async function run(definition: CronJobDefinition) {
  const service = new CronService() as unknown as CronServiceHarness;
  service.jobs.set(definition.id, { definition });
  await service.executeAction(definition, definition.action, 1000, 'exec-flat-fee');
}

const warnedFlatFee = () => warn.mock.calls.some(([message]) => String(message).includes('zero-priced'));

describe('cron agent run: 包月模型上的预算上限', () => {
  it('包月模型 + maxRunBudget>0：warn 一次并带 job/model/cap/原因', async () => {
    await run(cappedJob(0.5));
    const calls = warn.mock.calls.filter(([message]) => String(message).includes('zero-priced'));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      jobId: 'job-agent-snapshot',
      model: 'mimo-v2.6-flash',
      maxRunBudget: 0.5,
      reason: 'cap cannot trigger on a zero-priced model',
    });
  });

  it('glm-5.3 按量计价：不 warn', async () => {
    agentState.createSession.mockResolvedValue({
      id: 'cron-session-1', workingDirectory: undefined,
      modelConfig: { provider: 'zhipu', model: 'glm-5.3' },
    });
    await run(cappedJob(0.5));
    expect(warnedFlatFee()).toBe(false);
  });

  it('包月模型但没设上限：不 warn', async () => {
    await run(makeDefinition() as CronJobDefinition);
    expect(warnedFlatFee()).toBe(false);
  });
});
