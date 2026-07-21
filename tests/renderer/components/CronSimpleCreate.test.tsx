// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const createJob = vi.fn();

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    createJob: (input: unknown) => createJob(input),
  },
}));

import {
  CronSimpleCreate,
  buildSimpleDraft,
  compileSimpleSchedule,
} from '../../../src/renderer/components/features/cron/CronSimpleCreate';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('compileSimpleSchedule', () => {
  it('每天 08:30 → cron 30 8 * * *', () => {
    expect(compileSimpleSchedule({ freq: 'daily', time: '08:30', weekday: '1', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '30 8 * * *' });
  });

  it('工作日 → 1-5', () => {
    expect(compileSimpleSchedule({ freq: 'weekdays', time: '18:00', weekday: '1', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '0 18 * * 1-5' });
  });

  it('每周三 → day-of-week 3', () => {
    expect(compileSimpleSchedule({ freq: 'weekly', time: '10:15', weekday: '3', intervalHours: '1', onceAt: '' }))
      .toEqual({ scheduleType: 'cron', cronExpression: '15 10 * * 3' });
  });

  it('每隔 4 小时 → every/hours', () => {
    expect(compileSimpleSchedule({ freq: 'hourly', time: '09:00', weekday: '1', intervalHours: '4', onceAt: '' }))
      .toEqual({ scheduleType: 'every', everyInterval: '4', everyUnit: 'hours' });
  });

  it('只跑一次 → at + datetime', () => {
    expect(compileSimpleSchedule({ freq: 'once', time: '09:00', weekday: '1', intervalHours: '1', onceAt: '2026-08-01T09:00' }))
      .toEqual({ scheduleType: 'at', atDatetime: '2026-08-01T09:00' });
  });
});

describe('buildSimpleDraft', () => {
  it('组装 agent action，空名称回退目标前 20 字', () => {
    const goal = '每天读一遍我关注的竞品动态，整理成一份简报发给我过目';
    const draft = buildSimpleDraft(goal, '', { scheduleType: 'cron', cronExpression: '30 8 * * *' });
    expect(draft.actionType).toBe('agent');
    expect(draft.agentType).toBe('default');
    expect(draft.agentPrompt).toBe(goal);
    expect(draft.name).toBe(goal.slice(0, 20));
    // 全链路：draft 能通过 buildCronJobInput 校验并产出 agent action
    const input = buildCronJobInput(draft);
    expect(input.action).toEqual({ type: 'agent', agentType: 'default', prompt: goal, context: {} });
    expect(input.schedule).toEqual({ type: 'cron', expression: '30 8 * * *', timezone: undefined });
  });
});

describe('CronSimpleCreate', () => {
  it('空目标提交显示校验提示且不调 createJob', async () => {
    render(<CronSimpleCreate onDone={() => undefined} />);
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => {
      expect(screen.getByText('先告诉我要做什么')).toBeTruthy();
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('填目标提交后走 createJob，产出 agent+cron 任务', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'new-job',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), {
      target: { value: '每天帮我盯一下竞品发布' },
    });
    fireEvent.click(screen.getByText('创建自动化'));
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.action.type).toBe('agent');
    expect(submitted.schedule).toEqual({ type: 'cron', expression: '0 9 * * *', timezone: undefined });
    expect(submitted.enabled).toBe(true);
  });
});
