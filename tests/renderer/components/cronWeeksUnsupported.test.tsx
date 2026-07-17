import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CronJobDefinition } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/cronStore', () => ({
  useCronStore: () => ({
    createJob: vi.fn(),
    updateJob: vi.fn(),
  }),
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import {
  buildCronJobInput,
  createDefaultCronJobDraft,
  formatScheduleSummary,
} from '../../../src/renderer/components/features/cron/types';

function shellJob(unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks'): CronJobDefinition {
  // 'weeks' 已从 TimeUnit 移除（CronService 拒收），此处特意构造历史存量数据的形状
  // 来验证兼容路径，与生产侧 `(job.schedule.unit as string) === 'weeks'` 的判法一致。
  return {
    id: `job-${unit}`,
    name: 'Interval job',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 3, unit } as CronJobDefinition['schedule'],
    action: { type: 'shell', command: 'echo ok' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('cron weeks unsupported in renderer', () => {
  it('CronJobEditor no longer offers weeks as an every-unit option', () => {
    const html = renderToStaticMarkup(
      <CronJobEditor isOpen job={shellJob('hours')} onClose={() => {}} />,
    );

    expect(html).toContain('value="seconds"');
    expect(html).toContain('value="minutes"');
    expect(html).toContain('value="hours"');
    expect(html).toContain('value="days"');
    expect(html).not.toContain('value="weeks"');
    expect(html).not.toContain('>周</option>');
  });

  it('legacy weeks jobs are shown as unsupported instead of normal weekly schedules', () => {
    expect(formatScheduleSummary(shellJob('weeks'))).toBe('不支持的周间隔 · 3 weeks');
  });

  it('buildCronJobInput rejects weeks before sending payload to main', () => {
    const draft = createDefaultCronJobDraft();
    draft.name = 'Bad weeks job';
    draft.scheduleType = 'every';
    draft.everyInterval = '3';
    // 同上：模拟历史存量草稿里残留的 'weeks'，验证提交前的拒收路径。
    draft.everyUnit = 'weeks' as unknown as typeof draft.everyUnit;
    draft.shellCommand = 'echo ok';

    expect(() => buildCronJobInput(draft)).toThrow(/周间隔不受支持/);
  });
});
