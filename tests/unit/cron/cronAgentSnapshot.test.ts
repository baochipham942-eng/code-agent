import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAction,
  CronJobAction,
  CronJobDefinition,
} from '../../../src/shared/contract/cron';
import { CRON_AGENT_SNAPSHOT, EXTERNAL_WATCH } from '../../../src/shared/constants';

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
  getConfigService: () => ({
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

async function runAgentAction(
  context: Record<string, unknown> | undefined,
  finalAssistantText: string,
) {
  const service = new CronService();
  const definition = makeDefinition(context);
  const harness = service as unknown as CronServiceHarness;
  harness.jobs.set(definition.id, { definition });
  agentState.getMessages.mockReturnValue([assistantMessage(finalAssistantText)]);
  const updateJob = vi.spyOn(service, 'updateJob');

  await harness.executeAction(definition, definition.action, undefined, 'execution-1');

  return { service, definition, updateJob };
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

describe('CronService agent run snapshot wiring', () => {
  it('没开变化追踪的任务：prompt 原样发送，也不落任何快照', async () => {
    const { service, definition, updateJob } = await runAgentAction(
      { heartbeatTask: true },
      '本次结果\n<cron_snapshot>就算吐了标记也不该被存</cron_snapshot>',
    );

    expect(agentState.sendMessage).toHaveBeenCalledWith('检查网页', undefined, undefined);
    expect(updateJob).not.toHaveBeenCalled();
    expect(service.getJob(definition.id)?.action).toMatchObject({
      type: 'agent',
      context: { heartbeatTask: true },
    });
  });

  it('开了追踪但还没有旧快照：首次也必须带上输出标记的要求', async () => {
    // 首次不给这句，模型不知道要吐标记，第一次必然拿不到快照，
    // 变化追踪就永远起不来（或被迫拿整段回答顶替）。
    await runAgentAction({ [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true }, '本次结果');

    expect(agentState.sendMessage).toHaveBeenCalledWith(
      [
        '检查网页',
        '',
        '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。',
      ].join('\n'),
      undefined,
      undefined,
    );
  });

  it('开了追踪但模型没吐标记：不拿整段回答顶替', async () => {
    const { service, definition, updateJob } = await runAgentAction(
      { [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true },
      '我看了一下，页面内容大致是这样的……（一大段叙述）',
    );

    expect(updateJob).not.toHaveBeenCalled();
    const action = service.getJob(definition.id)?.action as AgentAction;
    expect(action.context?.[CRON_AGENT_SNAPSHOT.CONTEXT_KEY]).toBeUndefined();
  });

  it('有上次快照时才注入对比要求和快照标记格式', async () => {
    await runAgentAction(
      {
        [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
        [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '标题 A\n状态：开放',
      },
      '本次结果',
    );

    expect(agentState.sendMessage).toHaveBeenCalledWith(
      [
        '检查网页',
        '',
        '上次运行看到的快照：',
        '<previous_snapshot>',
        '标题 A\n状态：开放',
        '</previous_snapshot>',
        '',
        '请把上面的快照和本次看到的内容对比，这次只需要说明变化。',
        '',
        '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。',
      ].join('\n'),
      undefined,
      undefined,
    );
  });

  it('从最后一条 assistant 消息提取快照，经 updateJob 写回并在 cleanup 前完成', async () => {
    const { service, definition, updateJob } = await runAgentAction(
      { [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true },
      '标题从 A 改成 B。\n<cron_snapshot>\n标题 B\n状态：开放\n</cron_snapshot>',
    );

    expect(updateJob).toHaveBeenCalledWith(definition.id, {
      action: expect.objectContaining({
        type: 'agent',
        context: {
          [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
          [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '标题 B\n状态：开放',
        },
      }),
    });
    expect(service.getJob(definition.id)?.action).toMatchObject({
      type: 'agent',
      context: {
        [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '标题 B\n状态：开放',
      },
    });
    const persistedAction = JSON.parse(String(dbState.savedRows.at(-1)?.[5]));
    expect(persistedAction.context).toEqual({
      [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
      [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '标题 B\n状态：开放',
    });
    expect(updateJob.mock.invocationCallOrder[0]).toBeLessThan(
      agentState.cleanup.mock.invocationCallOrder[0],
    );
  });

  it('写回快照时保留 context 里的 heartbeat 和其他键', async () => {
    const { service, definition, updateJob } = await runAgentAction(
      { [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true, heartbeatTask: true, owner: 'ops' },
      '<cron_snapshot>页面版本 2</cron_snapshot>',
    );

    const expectedContext = {
      [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
      heartbeatTask: true,
      owner: 'ops',
      [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '页面版本 2',
    };
    expect(updateJob).toHaveBeenCalledWith(definition.id, {
      action: expect.objectContaining({ context: expectedContext }),
    });
    expect(service.getJob(definition.id)?.action).toMatchObject({
      type: 'agent',
      context: expectedContext,
    });
  });

  it('最终输出没有快照标记时保留上一次快照且不调用 updateJob', async () => {
    const previousContext = {
      [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
      heartbeatTask: true,
      [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: '页面版本 1',
    };
    const { service, definition, updateJob } = await runAgentAction(
      previousContext,
      '页面没有变化。',
    );

    expect(updateJob).not.toHaveBeenCalled();
    expect(service.getJob(definition.id)?.action).toMatchObject({
      type: 'agent',
      context: previousContext,
    });
    expect(dbState.savedRows).toHaveLength(0);
  });

  it('超长快照按 UTF-8 字节安全截断到上限内并记录日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const oversizedSnapshot = '中'.repeat(CRON_AGENT_SNAPSHOT.MAX_BYTES);
    const { service, definition } = await runAgentAction(
      { [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true },
      `<cron_snapshot>${oversizedSnapshot}</cron_snapshot>`,
    );

    const action = service.getJob(definition.id)?.action as AgentAction;
    const storedSnapshot = action.context?.[CRON_AGENT_SNAPSHOT.CONTEXT_KEY];
    expect(typeof storedSnapshot).toBe('string');
    expect(Buffer.byteLength(storedSnapshot as string, 'utf8'))
      .toBeLessThanOrEqual(CRON_AGENT_SNAPSHOT.MAX_BYTES);
    expect(oversizedSnapshot.startsWith(storedSnapshot as string)).toBe(true);
    expect(storedSnapshot).not.toContain('\uFFFD');
    expect(warn).toHaveBeenCalledWith(
      `[CronService] Agent snapshot exceeded ${CRON_AGENT_SNAPSHOT.MAX_BYTES} UTF-8 bytes; truncated`,
    );
  });
});

describe('CronService external_event 无变化则安静门', () => {
  const watchContext = {
    [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
    [EXTERNAL_WATCH.CONTEXT_KEY]: { source: EXTERNAL_WATCH.SOURCE_CALENDAR, calendarId: 'cal-1' },
  };

  async function runAndGetResult(
    context: Record<string, unknown> | undefined,
    finalAssistantText: string,
  ): Promise<Record<string, unknown>> {
    const service = new CronService();
    const definition = makeDefinition(context);
    const harness = service as unknown as CronServiceHarness;
    harness.jobs.set(definition.id, { definition });
    agentState.getMessages.mockReturnValue([assistantMessage(finalAssistantText)]);
    const result = await harness.executeAction(definition, definition.action, undefined, 'exec-watch');
    return result as Record<string, unknown>;
  }

  it('监听任务无 <cron_alert>：结果整成 skipped，供 isSkippedResult 门挡住收件箱', async () => {
    const result = await runAndGetResult(
      watchContext,
      '本次无新增冲突。\n<cron_snapshot>冲突对：无</cron_snapshot>',
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_new_event');
  });

  it('监听任务有 <cron_alert>：不 skipped，正常进待过目', async () => {
    const result = await runAndGetResult(
      watchContext,
      '<cron_alert>周会 15:00-16:00 与 评审 15:30-16:30 时间冲突</cron_alert>\n<cron_snapshot>冲突对：周会×评审</cron_snapshot>',
    );
    expect(result.skipped).toBeUndefined();
  });

  it('普通 agent 任务即使无 alert 标记也永不被静音', async () => {
    const result = await runAndGetResult(
      { heartbeatTask: true },
      '这只是一次普通心跳，没有任何标记。',
    );
    expect(result.skipped).toBeUndefined();
  });
});
