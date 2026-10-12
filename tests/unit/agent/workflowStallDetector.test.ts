import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRunEvent } from '../../../src/shared/contract/scriptRun';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';
import { WorkflowStallDetector } from '../../../src/host/agent/workflowStallDetector';

function event(runId: string, type: ScriptRunEvent['type']): ScriptRunEvent {
  return { runId, type, ts: Date.now() };
}

function makeJournal(maxEpoch = 0) {
  const rows: Array<{ runId: string; epoch: number; announcedAt: number }> = [];
  const journal = {
    getMaxStallEpoch: vi.fn(() => maxEpoch),
    recordStallNotice: vi.fn((runId, epoch, announcedAt = Date.now()) => {
      if (rows.some((row) => row.runId === runId && row.epoch === epoch)) return false;
      rows.push({ runId, epoch, announcedAt });
      return true;
    }),
  };
  return { journal, rows };
}

describe('WorkflowStallDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => vi.useRealTimers());

  it('announces after N_hard without progress and records before warning', async () => {
    const { journal, rows } = makeJournal();
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const detector = new WorkflowStallDetector({
      journal,
      logger: { warn: (message, details) => warnings.push({ message, details }) },
    });
    detector.startRun('wf-hard');

    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);

    expect(rows).toEqual([{ runId: 'wf-hard', epoch: 1, announcedAt: WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: 'workflow run stalled', details: { runId: 'wf-hard', epoch: 1, idleSeconds: 600 } });
  });

  it('pauses active time while parked and resumes after unpark', async () => {
    const { journal, rows } = makeJournal();
    const detector = new WorkflowStallDetector({ journal, logger: { warn: vi.fn() } });
    detector.startRun('wf-parked');
    await vi.advanceTimersByTimeAsync(300_000);
    detector.setParked('wf-parked', true);
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(rows).toHaveLength(0);

    detector.setParked('wf-parked', false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(rows).toHaveLength(1);
    expect(rows[0].epoch).toBe(1);
  });

  it('uses M rather than N_hard while an agent call is in flight', async () => {
    const { journal, rows } = makeJournal();
    const detector = new WorkflowStallDetector({ journal, logger: { warn: vi.fn() } });
    detector.startRun('wf-call');
    detector.handleEvent(event('wf-call', 'agent:start'));
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);
    expect(rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.SINGLE_CALL_MS - WORKFLOW_STALL_THRESHOLDS.N_HARD_MS - 1);
    expect(rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rows).toHaveLength(1);
  });

  it('stops after K epochs', async () => {
    const { journal, rows } = makeJournal();
    const detector = new WorkflowStallDetector({ journal, logger: { warn: vi.fn() } });
    detector.startRun('wf-cap');
    for (let epoch = 0; epoch < WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS; epoch += 1) {
      await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);
    }
    expect(rows.map((row) => row.epoch)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(rows).toHaveLength(WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS);
  });

  it('refreshes the clock on activity and stops on terminal events', async () => {
    const { journal, rows } = makeJournal();
    const detector = new WorkflowStallDetector({ journal, logger: { warn: vi.fn() } });
    detector.startRun('wf-activity');
    await vi.advanceTimersByTimeAsync(599_000);
    detector.handleEvent(event('wf-activity', 'run:log'));
    await vi.advanceTimersByTimeAsync(599_001);
    expect(rows).toHaveLength(0);
    detector.handleEvent(event('wf-activity', 'run:done'));
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(rows).toHaveLength(0);
  });

  it('warns when no journal is available and uses in-process epochs', async () => {
    const warnings: string[] = [];
    const detector = new WorkflowStallDetector({
      journal: null,
      logger: { warn: (message) => warnings.push(message) },
    });
    detector.startRun('wf-memory');
    await vi.advanceTimersByTimeAsync(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1);
    expect(warnings).toEqual([
      'workflow stall detector downgraded to in-process epochs',
      'workflow run stalled',
    ]);
  });
});
