import { describe, expect, it } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';
import { EXTERNAL_WATCH } from '../../../src/shared/constants/feishu';
import { getCronTriggerKind } from '../../../src/renderer/utils/cronHumanize';

describe('getCronTriggerKind', () => {
  function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
    return {
      id: 'job-1',
      runsOn: 'local',
      name: 'demo',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '30 8 * * *' },
      action: { type: 'agent', agentType: 'default', prompt: 'hi' },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  it('普通 cron 任务 → cron', () => {
    expect(getCronTriggerKind(makeJob({}))).toBe('cron');
  });

  it('一次性 / 循环按 scheduleType 细分', () => {
    expect(getCronTriggerKind(makeJob({
      scheduleType: 'at',
      schedule: { type: 'at', datetime: '2030-01-01T00:00:00Z' },
    }))).toBe('at');
    expect(getCronTriggerKind(makeJob({
      scheduleType: 'every',
      schedule: { type: 'every', interval: 2, unit: 'hours' },
    }))).toBe('every');
  });

  it('agent.context.heartbeatTask → heartbeat（对齐 cronAutomationBridge）', () => {
    expect(getCronTriggerKind(makeJob({
      action: { type: 'agent', agentType: 'default', prompt: 'hi', context: { heartbeatTask: true } },
    }))).toBe('heartbeat');
  });

  it('agent.context[externalWatch] → external_event，优先于 heartbeat', () => {
    expect(getCronTriggerKind(makeJob({
      action: {
        type: 'agent',
        agentType: 'default',
        prompt: 'hi',
        context: { [EXTERNAL_WATCH.CONTEXT_KEY]: { source: 'feishu-calendar' }, heartbeatTask: true },
      },
    }))).toBe('external_event');
  });

  it('非 agent 动作不看 context', () => {
    expect(getCronTriggerKind(makeJob({
      action: { type: 'shell', command: 'echo ok' },
    }))).toBe('cron');
  });
});
