import { describe, expect, it, vi } from 'vitest';
import {
  DREAM_AUTO_PROMPT,
  DREAM_CRON_JOB_TAG,
  DREAM_INTERVAL_DAYS,
  buildDreamCronJobDefinition,
  syncDreamCronJob,
} from '../../../../src/main/services/memory/dreamScheduler';

const NOW = Date.UTC(2026, 5, 11, 9, 0, 0);

describe('dreamScheduler', () => {
  it('builds a 7-day automatic /dream job with an injected clock', () => {
    const job = buildDreamCronJobDefinition({
      now: NOW,
      workingDirectory: '/repo',
    });

    expect(DREAM_INTERVAL_DAYS).toBe(7);
    expect(job.scheduleType).toBe('every');
    expect(job.schedule).toEqual({
      type: 'every',
      interval: 7,
      unit: 'days',
      startAt: NOW,
    });
    expect(job.action).toMatchObject({
      type: 'agent',
      agentType: 'dream',
      prompt: DREAM_AUTO_PROMPT,
      context: { workingDirectory: '/repo', dreamAuto: true },
    });
    expect(job.tags).toContain(DREAM_CRON_JOB_TAG);
  });

  it('registers the automatic job idempotently by tag', async () => {
    const cron = {
      listJobs: vi.fn(() => []),
      createJob: vi.fn(async (job) => ({ id: 'job-dream', createdAt: NOW, updatedAt: NOW, ...job })),
    };

    const result = await syncDreamCronJob(cron, {
      now: NOW,
      workingDirectory: '/repo',
    });

    expect(cron.listJobs).toHaveBeenCalledWith({ tags: [DREAM_CRON_JOB_TAG] });
    expect(cron.createJob).toHaveBeenCalledWith(expect.objectContaining({
      schedule: expect.objectContaining({ interval: 7, unit: 'days' }),
      action: expect.objectContaining({ prompt: '/dream --auto' }),
    }));
    expect(result.created).toBe(true);
  });

  it('does not create a duplicate automatic job when one already exists', async () => {
    const existing = { id: 'job-existing', tags: [DREAM_CRON_JOB_TAG] };
    const cron = {
      listJobs: vi.fn(() => [existing]),
      createJob: vi.fn(),
    };

    const result = await syncDreamCronJob(cron, {
      now: NOW,
      workingDirectory: '/repo',
    });

    expect(result).toEqual({ created: false, job: existing });
    expect(cron.createJob).not.toHaveBeenCalled();
  });
});
