import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CronJobDefinition,
  CronJobExecution,
} from '../../../src/shared/contract/cron';

const service = {
  recordCreated: vi.fn(),
  upsert: vi.fn(),
  getBySourceRef: vi.fn(),
  recordEvent: vi.fn(),
};

vi.mock('../../../src/main/services/sessionAutomation', () => ({
  getSessionAutomationService: () => service,
}));

import {
  readCronSourceSessionId,
  getCronAutomationType,
  buildCronAutomationConfig,
  formatCronScheduleLabel,
  recordCronAutomationCreated,
  syncCronAutomationFromJob,
  recordCronAutomationArchived,
  recordCronAutomationExecution,
} from '../../../src/main/cron/cronAutomationBridge';

const def = (over: Partial<CronJobDefinition> = {}): CronJobDefinition => ({
  id: 'job-1',
  name: 'My Job',
  scheduleType: 'every',
  schedule: { type: 'every', interval: 5, unit: 'minutes' },
  action: { type: 'shell', command: 'echo hi' },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const identityRuntime = (d: CronJobDefinition) => d;

beforeEach(() => {
  vi.clearAllMocks();
  service.getBySourceRef.mockReturnValue(null);
  service.recordCreated.mockResolvedValue(undefined);
  service.recordEvent.mockResolvedValue(undefined);
});

describe('readCronSourceSessionId', () => {
  it('prefers metadata.sourceSessionId', () => {
    expect(readCronSourceSessionId(def({ metadata: { sourceSessionId: 'sess-meta' } }))).toBe('sess-meta');
  });

  it('falls back to an agent action context source', () => {
    expect(
      readCronSourceSessionId(
        def({ action: { type: 'agent', agentType: 'a', prompt: 'p', context: { sourceSessionId: 'sess-ctx' } } })
      )
    ).toBe('sess-ctx');
  });

  it('returns undefined when neither source is present or blank', () => {
    expect(readCronSourceSessionId(def())).toBeUndefined();
    expect(readCronSourceSessionId(def({ metadata: { sourceSessionId: '   ' } }))).toBeUndefined();
  });
});

describe('getCronAutomationType', () => {
  it('is heartbeat for an agent action flagged as a heartbeat task', () => {
    expect(
      getCronAutomationType(
        def({ action: { type: 'agent', agentType: 'a', prompt: 'p', context: { heartbeatTask: true } } })
      )
    ).toBe('heartbeat');
  });

  it('is cron otherwise', () => {
    expect(getCronAutomationType(def())).toBe('cron');
    expect(
      getCronAutomationType(def({ action: { type: 'agent', agentType: 'a', prompt: 'p' } }))
    ).toBe('cron');
  });
});

describe('buildCronAutomationConfig', () => {
  it('defaults createdVia to "cron" and omits absent optional fields', () => {
    const config = buildCronAutomationConfig(def());
    expect(config.createdVia).toBe('cron');
    expect(config.scheduleType).toBe('every');
    expect(config.actionType).toBe('shell');
    expect(config).not.toHaveProperty('handoffPrompt');
    expect(config).not.toHaveProperty('nextStage');
  });

  it('carries through handoffPrompt and a non-empty nextStage', () => {
    const config = buildCronAutomationConfig(
      def({
        metadata: {
          createdVia: 'heartbeat',
          handoffPrompt: '  do next  ',
          nextStage: { prompt: ' go ', goal: '', title: '  ' },
        },
      })
    );
    expect(config.createdVia).toBe('heartbeat');
    expect(config.handoffPrompt).toBe('do next');
    expect(config.nextStage).toEqual({ prompt: 'go' });
  });

  it('drops a nextStage with only blank fields', () => {
    const config = buildCronAutomationConfig(def({ metadata: { nextStage: { prompt: '  ', goal: '' } } }));
    expect(config).not.toHaveProperty('nextStage');
  });
});

describe('formatCronScheduleLabel', () => {
  it('formats interval schedules with localized units', () => {
    expect(formatCronScheduleLabel({ type: 'every', interval: 3, unit: 'hours' })).toBe('每 3 小时');
  });

  it('formats a valid one-time datetime and falls back for an invalid one', () => {
    const numeric = formatCronScheduleLabel({ type: 'at', datetime: Date.UTC(2026, 0, 2, 3, 4) });
    expect(numeric).toMatch(/\d/);
    expect(formatCronScheduleLabel({ type: 'at', datetime: 'not-a-date' })).toBe('一次性');
  });

  it('formats cron expressions with optional timezone', () => {
    expect(formatCronScheduleLabel({ type: 'cron', expression: '0 9 * * *' })).toBe('0 9 * * *');
    expect(
      formatCronScheduleLabel({ type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' })
    ).toBe('0 9 * * * · Asia/Shanghai');
  });
});

describe('recordCronAutomationCreated', () => {
  it('skips entirely without a source session id', async () => {
    await recordCronAutomationCreated(def(), identityRuntime);
    expect(service.recordCreated).not.toHaveBeenCalled();
  });

  it('records creation with a composed id and enabled status', async () => {
    await recordCronAutomationCreated(
      def({ metadata: { sourceSessionId: 'sess' }, enabled: false }),
      identityRuntime
    );
    expect(service.recordCreated).toHaveBeenCalledTimes(1);
    const arg = service.recordCreated.mock.calls[0][0];
    expect(arg.id).toBe('cron:job-1');
    expect(arg.sourceSessionId).toBe('sess');
    expect(arg.status).toBe('paused');
    expect(arg.cadenceLabel).toBe('每 5 分钟');
  });

  it('swallows service errors', async () => {
    service.recordCreated.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordCronAutomationCreated(def({ metadata: { sourceSessionId: 'sess' } }), identityRuntime)
    ).resolves.toBeUndefined();
  });
});

describe('syncCronAutomationFromJob', () => {
  it('upserts the full automation contract, including the resolved nextRunAt', () => {
    // A resolver that injects runtime scheduling state — the upsert must carry it.
    const resolveRuntime = (d: CronJobDefinition) => ({ ...d, nextRunAt: 999_000 });
    syncCronAutomationFromJob(
      def({ id: 'job-9', name: 'Nightly', enabled: false, metadata: { sourceSessionId: 'sess' } }),
      resolveRuntime
    );
    expect(service.upsert).toHaveBeenCalledTimes(1);
    expect(service.upsert.mock.calls[0][0]).toMatchObject({
      id: 'cron:job-9',
      sourceSessionId: 'sess',
      type: 'cron',
      status: 'paused', // enabled: false
      title: 'Nightly',
      cadenceLabel: '每 5 分钟',
      nextRunAt: 999_000,
      sourceRefId: 'job-9',
      config: { createdVia: 'cron', scheduleType: 'every', actionType: 'shell' },
    });
  });

  it('does nothing without a source session', () => {
    syncCronAutomationFromJob(def(), identityRuntime);
    expect(service.upsert).not.toHaveBeenCalled();
  });
});

describe('recordCronAutomationArchived', () => {
  it('seeds a record when none exists then emits a cancelled event', async () => {
    service.getBySourceRef.mockReturnValue(null);
    await recordCronAutomationArchived(def({ metadata: { sourceSessionId: 'sess' } }));
    expect(service.upsert).toHaveBeenCalledTimes(1);
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
    expect(service.recordEvent.mock.calls[0][0]).toMatchObject({ event: 'cancelled', status: 'cancelled' });
  });

  it('skips the seed upsert when a record already exists', async () => {
    service.getBySourceRef.mockReturnValue({ id: 'existing' });
    await recordCronAutomationArchived(def({ metadata: { sourceSessionId: 'sess' } }));
    expect(service.upsert).not.toHaveBeenCalled();
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
  });
});

describe('recordCronAutomationExecution', () => {
  const exec = (over: Partial<CronJobExecution> = {}): CronJobExecution => ({
    id: 'exec-1',
    jobId: 'job-1',
    status: 'completed',
    scheduledAt: 0,
    retryAttempt: 0,
    ...over,
  });

  it('maps a completed execution to a completed event, kept active for recurring jobs', async () => {
    await recordCronAutomationExecution(
      def({ metadata: { sourceSessionId: 'sess' }, scheduleType: 'every' }),
      exec({ status: 'completed' }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.event).toBe('completed');
    expect(arg.status).toBe('completed');
    expect(arg.recordStatus).toBe('active'); // recurring → stays active
  });

  it('maps a skipped result to a skipped event', async () => {
    await recordCronAutomationExecution(
      def({ metadata: { sourceSessionId: 'sess' } }),
      exec({ status: 'completed', result: { skipped: true } }),
      identityRuntime
    );
    expect(service.recordEvent.mock.calls[0][0]).toMatchObject({ event: 'skipped', status: 'skipped' });
  });

  it('maps a failed execution and uses the event status for one-time jobs', async () => {
    // One-time job: scheduleType AND schedule must both be 'at' (no contract drift),
    // so the seeded upsert carries the real one-time cadence label.
    service.getBySourceRef.mockReturnValue(null);
    await recordCronAutomationExecution(
      def({
        metadata: { sourceSessionId: 'sess' },
        scheduleType: 'at',
        schedule: { type: 'at', datetime: Date.UTC(2026, 0, 2, 3, 4) },
        enabled: true,
      }),
      exec({ status: 'failed', error: 'boom' }),
      identityRuntime
    );
    const arg = service.recordEvent.mock.calls[0][0];
    expect(arg.event).toBe('failed');
    expect(arg.recordStatus).toBe('failed'); // one-time job → not kept active
    expect(arg.error).toBe('boom');
    // The seed upsert reflects the one-time schedule, not a recurring one.
    expect(service.upsert.mock.calls[0][0].cadenceLabel).not.toContain('每');
  });

  it('does nothing without a source session', async () => {
    await recordCronAutomationExecution(def(), exec(), identityRuntime);
    expect(service.recordEvent).not.toHaveBeenCalled();
  });
});
