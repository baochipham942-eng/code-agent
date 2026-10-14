// ============================================================================
// formatScheduleSummary cron 档（FB-326 返修）：频率摘要走共享
// formatCronExpressionLabel——常见形态翻人话，复杂式带「自定义时间」前缀，
// 不再裸露 cron 表达式。展示点清单见证据档 ④。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';
import { formatScheduleSummary } from '../../../src/renderer/components/features/cron/types';

function cronJob(expression: string, timezone?: string): CronJobDefinition {
  return {
    id: `job-${expression}`,
    runsOn: 'local',
    name: 'Cron job',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression, timezone },
    action: { type: 'shell', command: 'echo ok' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('formatScheduleSummary cron 档（与通知同源的人话文案）', () => {
  it('常见形态翻人话：17 8 * * * → 每天 08:17（不再裸 cron）', () => {
    expect(formatScheduleSummary(cronJob('17 8 * * *', 'Asia/Shanghai'))).toBe('每天 08:17');
  });

  it('复杂表达式带「自定义时间」前缀：0 9 1,15 * * · Asia/Shanghai（zh/en）', () => {
    expect(formatScheduleSummary(cronJob('0 9 1,15 * *', 'Asia/Shanghai'), 'zh'))
      .toBe('自定义时间 · 0 9 1,15 * * · Asia/Shanghai');
    expect(formatScheduleSummary(cronJob('0 9 1,15 * *', 'Asia/Shanghai'), 'en'))
      .toBe('Custom schedule · 0 9 1,15 * * · Asia/Shanghai');
  });

  it('复杂表达式无时区：只带原文，不挂多余的时段', () => {
    expect(formatScheduleSummary(cronJob('0 9 * * 1,3,5'), 'zh')).toBe('自定义时间 · 0 9 * * 1,3,5');
  });
});
