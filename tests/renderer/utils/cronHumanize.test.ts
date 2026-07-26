import { describe, expect, it } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';
import { EXTERNAL_WATCH } from '../../../src/shared/constants/feishu';
import {
  getCronTriggerKind,
  humanizeCronExpression,
  humanizeEverySchedule,
} from '../../../src/renderer/utils/cronHumanize';

describe('humanizeCronExpression', () => {
  it('每天定点：30 8 * * *', () => {
    expect(humanizeCronExpression('30 8 * * *', 'zh')).toBe('每天 08:30');
    expect(humanizeCronExpression('30 8 * * *', 'en')).toBe('Daily at 08:30');
  });

  it('工作日定点：0 15 * * 1-5', () => {
    expect(humanizeCronExpression('0 15 * * 1-5', 'zh')).toBe('工作日 15:00');
    expect(humanizeCronExpression('0 15 * * 1-5', 'en')).toBe('Weekdays at 15:00');
  });

  it('每周单天：30 17 * * 4', () => {
    expect(humanizeCronExpression('30 17 * * 4', 'zh')).toBe('每周四 17:30');
    expect(humanizeCronExpression('30 17 * * 4', 'en')).toBe('Weekly on Thursday at 17:30');
    expect(humanizeCronExpression('0 9 * * 0', 'zh')).toBe('每周日 09:00');
  });

  it('每 N 分钟：*/15 * * * *', () => {
    expect(humanizeCronExpression('*/15 * * * *', 'zh')).toBe('每 15 分钟');
    expect(humanizeCronExpression('*/15 * * * *', 'en')).toBe('Every 15 minutes');
    expect(humanizeCronExpression('*/1 * * * *', 'en')).toBe('Every minute');
  });

  it('每 N 小时：0 */2 * * *', () => {
    expect(humanizeCronExpression('0 */2 * * *', 'zh')).toBe('每 2 小时');
    expect(humanizeCronExpression('0 */2 * * *', 'en')).toBe('Every 2 hours');
    expect(humanizeCronExpression('30 */1 * * *', 'en')).toBe('Every hour');
  });

  it('覆盖不了的形态回退 null，交给调用方显示原表达式', () => {
    // 多天列表、带日/月段、范围小时、6 段表达式、乱码
    expect(humanizeCronExpression('0 9 * * 1,3,5', 'zh')).toBeNull();
    expect(humanizeCronExpression('0 9 1 * *', 'zh')).toBeNull();
    expect(humanizeCronExpression('0 9 * 6 *', 'zh')).toBeNull();
    expect(humanizeCronExpression('0 9-17 * * *', 'zh')).toBeNull();
    expect(humanizeCronExpression('0 9 * * * *', 'zh')).toBeNull();
    expect(humanizeCronExpression('not a cron', 'zh')).toBeNull();
    // 超界
    expect(humanizeCronExpression('99 8 * * *', 'zh')).toBeNull();
    expect(humanizeCronExpression('0 25 * * *', 'zh')).toBeNull();
    expect(humanizeCronExpression('*/0 * * * *', 'zh')).toBeNull();
  });

  it('容忍首尾空白与连续空格', () => {
    expect(humanizeCronExpression('  30   8  *  *  * ', 'zh')).toBe('每天 08:30');
  });
});

describe('humanizeEverySchedule', () => {
  it('zh：每 N <中文单位>', () => {
    expect(humanizeEverySchedule(30, 'minutes', 'zh')).toBe('每 30 分钟');
    expect(humanizeEverySchedule(2, 'hours', 'zh')).toBe('每 2 小时');
    expect(humanizeEverySchedule(1, 'days', 'zh')).toBe('每 1 天');
    expect(humanizeEverySchedule(45, 'seconds', 'zh')).toBe('每 45 秒');
  });

  it('en：单复数', () => {
    expect(humanizeEverySchedule(1, 'hours', 'en')).toBe('Every hour');
    expect(humanizeEverySchedule(3, 'hours', 'en')).toBe('Every 3 hours');
    expect(humanizeEverySchedule(1, 'days', 'en')).toBe('Every day');
  });

  it('未知 unit 原样带上', () => {
    expect(humanizeEverySchedule(3, 'weeks', 'zh')).toBe('每 3 weeks');
  });
});

describe('getCronTriggerKind', () => {
  function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
    return {
      id: 'job-1',
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
