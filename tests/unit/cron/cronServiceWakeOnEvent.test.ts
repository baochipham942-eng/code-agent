// ============================================================================
// self-wake × external_event 接线：业务事件监听任务只在真有新告警时才叫醒
// ----------------------------------------------------------------------------
// notifyWakeOnJobCompleted 原先对所有任务无条件调用 WakeService.onEvent(jobName)，
// 包括 external_event（飞书日历冲突/表格变更监听）任务每一次安静的轮询 tick——
// 这会让 wake_on_event 在没有真实业务事件时反复叫醒等它的会话，几轮就把每会话
// 20 次配额烧光。这里验证新增的判据：external_event 任务只有在真有 <cron_alert>
// （execution.result 无 skipped 标记）时才叫醒；普通任务保持原有的「跑完就算数」。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';
import { EXTERNAL_WATCH } from '../../../src/shared/constants';

const wakeState = vi.hoisted(() => ({
  onJobCompleted: vi.fn(async () => 0),
  onEvent: vi.fn(async () => 0),
}));

vi.mock('../../../src/host/services/wake/wakeService', () => ({
  getWakeService: () => wakeState,
}));

import { CronService } from '../../../src/host/cron/cronService';

interface CronServiceHarness {
  notifyWakeOnJobCompleted(definition: CronJobDefinition, execution: CronJobExecution): Promise<void>;
}

function makeDefinition(name: string, context?: Record<string, unknown>): CronJobDefinition {
  return {
    id: 'job-1',
    name,
    scheduleType: 'every',
    schedule: { type: 'every', interval: 15, unit: 'minutes' },
    action: { type: 'agent', agentType: 'default', prompt: 'p', ...(context ? { context } : {}) },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeExecution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'exec-1',
    jobId: 'job-1',
    status: 'completed',
    scheduledAt: 1,
    startedAt: 1,
    retryAttempt: 0,
    ...overrides,
  };
}

function watchContext(source: typeof EXTERNAL_WATCH.SOURCE_CALENDAR | typeof EXTERNAL_WATCH.SOURCE_TABLE) {
  return {
    [EXTERNAL_WATCH.CONTEXT_KEY]:
      source === EXTERNAL_WATCH.SOURCE_CALENDAR
        ? { source, calendarId: 'cal-1' }
        : { source, baseAppToken: 'app-1', tableId: 'tbl-1' },
  };
}

beforeEach(() => {
  wakeState.onJobCompleted.mockClear();
  wakeState.onEvent.mockClear();
});

describe('CronService self-wake gating for external_event automations', () => {
  it('业务事件监听任务安静轮询（无新料）不叫醒任何等它的会话', async () => {
    const harness = new CronService() as unknown as CronServiceHarness;
    const definition = makeDefinition('飞书日历冲突监控', watchContext(EXTERNAL_WATCH.SOURCE_CALENDAR));
    const execution = makeExecution({ result: { skipped: true, reason: 'no_new_event' } });

    await harness.notifyWakeOnJobCompleted(definition, execution);

    expect(wakeState.onJobCompleted).not.toHaveBeenCalled();
    expect(wakeState.onEvent).not.toHaveBeenCalled();
  });

  it('业务事件监听任务真有新告警时才叫醒等它的会话', async () => {
    const harness = new CronService() as unknown as CronServiceHarness;
    const definition = makeDefinition('飞书日历冲突监控', watchContext(EXTERNAL_WATCH.SOURCE_CALENDAR));
    const execution = makeExecution({ result: { sessionId: 's1' } }); // 无 skipped 标记 = 有新料

    await harness.notifyWakeOnJobCompleted(definition, execution);

    expect(wakeState.onJobCompleted).toHaveBeenCalledWith('job-1');
    expect(wakeState.onEvent).toHaveBeenCalledWith('飞书日历冲突监控');
  });

  it('业务事件监听任务执行失败也不叫醒（避免把出错误判成事件）', async () => {
    const harness = new CronService() as unknown as CronServiceHarness;
    const definition = makeDefinition('飞书表格监控', watchContext(EXTERNAL_WATCH.SOURCE_TABLE));
    const execution = makeExecution({ status: 'failed', error: 'boom' });

    await harness.notifyWakeOnJobCompleted(definition, execution);

    expect(wakeState.onJobCompleted).not.toHaveBeenCalled();
    expect(wakeState.onEvent).not.toHaveBeenCalled();
  });

  it('普通自动化任务每次跑完都算数（不受 external_event 判据影响）', async () => {
    const harness = new CronService() as unknown as CronServiceHarness;
    const definition = makeDefinition('每日巡检'); // 无 externalWatch context
    const execution = makeExecution(); // 无 skipped 标记，也没有 externalWatch

    await harness.notifyWakeOnJobCompleted(definition, execution);

    expect(wakeState.onJobCompleted).toHaveBeenCalledWith('job-1');
    expect(wakeState.onEvent).toHaveBeenCalledWith('每日巡检');
  });
});
