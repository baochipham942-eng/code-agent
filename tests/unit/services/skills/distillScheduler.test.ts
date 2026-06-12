import { describe, expect, it, vi } from 'vitest';
import { DISTILL } from '../../../../src/shared/constants';
import {
  DISTILL_AUTO_PROMPT,
  DISTILL_CRON_JOB_TAG,
  buildDistillCronJobDefinition,
  syncDistillCronJob,
} from '../../../../src/main/services/skills/distillScheduler';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

describe('distillScheduler', () => {
  it('builds a 30-day automatic /distill job with an injected clock（时间注入，不偷用 Date.now）', () => {
    const job = buildDistillCronJobDefinition({
      now: NOW,
      workingDirectory: '/repo',
    });

    expect(DISTILL.INTERVAL_DAYS).toBe(30);
    expect(job.scheduleType).toBe('every');
    expect(job.schedule).toEqual({
      type: 'every',
      interval: 30,
      unit: 'days',
      startAt: NOW,
    });
    expect(job.action).toMatchObject({
      type: 'agent',
      agentType: 'distill',
      prompt: DISTILL_AUTO_PROMPT,
      context: { workingDirectory: '/repo', distillAuto: true },
    });
    expect(DISTILL_AUTO_PROMPT).toBe('/distill --auto');
    expect(job.tags).toContain(DISTILL_CRON_JOB_TAG);
  });

  it('registers the automatic job idempotently by tag', async () => {
    const cron = {
      listJobs: vi.fn(() => []),
      createJob: vi.fn(async (job) => ({ id: 'job-distill', createdAt: NOW, updatedAt: NOW, ...job })),
    };

    const result = await syncDistillCronJob(cron, { now: NOW, workingDirectory: '/repo' });

    expect(cron.listJobs).toHaveBeenCalledWith({ tags: [DISTILL_CRON_JOB_TAG] });
    expect(cron.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: expect.objectContaining({ interval: 30, unit: 'days', startAt: NOW }),
        action: expect.objectContaining({ prompt: '/distill --auto' }),
      }),
    );
    expect(result.created).toBe(true);
  });

  it('does not create a duplicate automatic job when one already exists', async () => {
    const existing = { id: 'job-existing', tags: [DISTILL_CRON_JOB_TAG] };
    const cron = {
      listJobs: vi.fn(() => [existing]),
      createJob: vi.fn(),
    };

    const result = await syncDistillCronJob(cron, { now: NOW, workingDirectory: '/repo' });

    expect(result).toEqual({ created: false, job: existing });
    expect(cron.createJob).not.toHaveBeenCalled();
  });
});
