// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    maxRetries: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('CronJobDetail', () => {
  it('业务网格显示下次运行时间', () => {
    const next = Date.now() + 3_600_000;
    render(<CronJobDetail job={makeJob({ nextRunAt: next })} />);
    const card = screen.getByTestId('cron-detail-next-run');
    expect(card.textContent).toContain('下次运行');
    expect(card.textContent).not.toContain('—');
  });

  it('停用任务的下次运行显示占位符', () => {
    render(<CronJobDetail job={makeJob({ enabled: false, nextRunAt: Date.now() + 3_600_000 })} />);
    expect(screen.getByTestId('cron-detail-next-run').textContent).toContain('—');
  });

  it('重试/超时等工程参数收进高级折叠区且默认收起', () => {
    render(<CronJobDetail job={makeJob({ timeout: 60_000 })} />);
    const advanced = screen.getByTestId('cron-detail-advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    // 工程参数在折叠区内部而不在业务网格
    expect(advanced.textContent).toContain('最大重试');
    expect(advanced.textContent).toContain('超时');
  });

  it('空态显示选择引导', () => {
    render(<CronJobDetail job={null} />);
    expect(screen.getByText('选择一个任务查看详情')).toBeTruthy();
  });
});
