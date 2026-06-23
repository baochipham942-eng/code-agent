import { describe, expect, it, vi } from 'vitest';
import {
  ExecutionMonitor,
  createExecutionMonitor,
  type MonitorConfig,
} from '../../../src/main/planning/executionMonitor';
import type { TaskPlan, TaskPhase } from '../../../src/main/planning/types';

const phase = (over: Partial<TaskPhase> & { id: string }): TaskPhase => ({
  title: 'Phase',
  status: 'pending',
  steps: [],
  ...over,
});

const plan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  id: 'plan',
  title: 'Plan',
  objective: 'obj',
  phases: [],
  createdAt: 0,
  updatedAt: 0,
  metadata: { totalSteps: 0, completedSteps: 0, blockedSteps: 0 },
  ...over,
});

describe('ExecutionMonitor.getProgress', () => {
  it('reports not_started before a plan is attached', () => {
    const m = new ExecutionMonitor();
    const p = m.getProgress();
    expect(p.status).toBe('not_started');
    expect(p.totalSteps).toBe(0);
    expect(p.currentPhaseId).toBeNull();
  });

  it('computes percent + current phase/step while in progress', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({
        phases: [
          phase({
            id: 'ph1',
            status: 'in_progress',
            steps: [
              { id: 'st1', content: 'a', status: 'completed' },
              { id: 'st2', content: 'b', status: 'in_progress' },
            ],
          }),
        ],
        metadata: { totalSteps: 4, completedSteps: 0, blockedSteps: 0 },
      })
    );
    m.recordStepComplete('ph1', 'st1');

    const p = m.getProgress();
    expect(p.completedSteps).toBe(1);
    expect(p.totalSteps).toBe(4);
    expect(p.progressPercent).toBe(25);
    expect(p.currentPhaseId).toBe('ph1');
    expect(p.currentStepId).toBe('st2');
    expect(p.status).toBe('in_progress');
  });

  it('reports completed when all steps are done', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({
        phases: [
          phase({
            id: 'ph1',
            status: 'in_progress',
            steps: [{ id: 'st1', content: 'a', status: 'completed' }],
          }),
        ],
        metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
      })
    );
    m.recordStepComplete('ph1', 'st1');
    expect(m.getProgress().status).toBe('completed');
  });

  it('reports paused when paused mid-flight', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(plan({ metadata: { totalSteps: 2, completedSteps: 0, blockedSteps: 0 } }));
    m.pause();
    expect(m.getProgress().status).toBe('paused');
    m.resume();
    expect(m.getProgress().status).toBe('in_progress');
  });
});

describe('ExecutionMonitor deviations', () => {
  it('flags an unexpected tool only once expectations exist', () => {
    const m = new ExecutionMonitor();
    // No plan yet → expectedTools empty → no deviation.
    m.recordToolCall('bash');
    expect(m.getDeviations()).toHaveLength(0);

    m.startMonitoring(
      plan({
        phases: [phase({ id: 'p', steps: [{ id: 's', content: '使用 `bash` 工具', status: 'pending' }] })],
      })
    );
    m.recordToolCall('bash'); // expected
    m.recordToolCall('write_file'); // unexpected
    const devs = m.getDeviations();
    expect(devs).toHaveLength(1);
    expect(devs[0].type).toBe('unexpected_tool_use');
  });

  it('flags an unexpected file write but not a read', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({
        phases: [phase({ id: 'p', steps: [{ id: 's', content: '修改 `app.ts`', status: 'pending' }] })],
      })
    );
    m.recordFileAccess('other.ts', 'read'); // reads never deviate
    m.recordFileAccess('app.ts', 'write'); // expected
    m.recordFileAccess('rogue.ts', 'write'); // unexpected
    const devs = m.getDeviations().filter((d) => d.type === 'unexpected_file_access');
    expect(devs).toHaveLength(1);
    expect(devs[0].context?.filePath).toBe('rogue.ts');
  });

  it('warns when iterations approach the configured ceiling', () => {
    const m = new ExecutionMonitor({ maxIterations: 5, timeoutThreshold: 10 ** 9 });
    m.startMonitoring(plan());
    for (let i = 0; i < 5; i++) m.recordIteration();
    expect(m.getDeviations().some((d) => d.type === 'iteration_warning')).toBe(true);
  });

  it('warns when elapsed time approaches the timeout threshold', () => {
    // Control the clock so elapsed deterministically exceeds 0.8 * threshold.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
    try {
      const m = new ExecutionMonitor({ timeoutThreshold: 1000, maxIterations: 10 ** 9 });
      m.startMonitoring(plan()); // startTime = 0
      m.recordIteration(); // elapsed = 10_000 > 0.8 * 1000
      expect(m.getDeviations().some((d) => d.type === 'timeout_warning')).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('detects a skipped predecessor step', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({
        phases: [
          phase({
            id: 'ph',
            steps: [
              { id: 'a', content: 'first', status: 'pending' },
              { id: 'b', content: 'second', status: 'pending' },
            ],
          }),
        ],
      })
    );
    m.recordStepComplete('ph', 'b'); // 'a' never completed
    expect(m.getDeviations().some((d) => d.type === 'step_skip')).toBe(true);
  });

  it('detects rollback operations by keyword', () => {
    const m = new ExecutionMonitor();
    m.detectRollback('git reset --hard HEAD');
    m.detectRollback('npm install lodash'); // not a rollback
    const devs = m.getDeviations().filter((d) => d.type === 'rollback_detected');
    expect(devs).toHaveLength(1);
  });
});

describe('ExecutionMonitor stats + callbacks + report', () => {
  it('aggregates deviations by type and severity with a rate', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({ phases: [phase({ id: 'p', steps: [{ id: 's', content: '修改 `x.ts`', status: 'pending' }] })] })
    );
    m.recordFileAccess('rogue.ts', 'write');
    const stats = m.getDeviationStats();
    expect(stats.total).toBe(1);
    expect(stats.byType.unexpected_file_access).toBe(1);
    expect(stats.bySeverity.warning).toBe(1);
    expect(stats.deviationRate).toBeGreaterThan(0);
  });

  it('returns a zero rate when nothing has been recorded', () => {
    const m = new ExecutionMonitor();
    expect(m.getDeviationStats().deviationRate).toBe(0);
  });

  it('fires onWarning callbacks for warning-severity deviations', () => {
    const onWarning = vi.fn();
    const m = new ExecutionMonitor({ onWarning });
    m.detectRollback('git checkout main');
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('auto-pauses when the deviation rate exceeds tolerance', () => {
    const config: Partial<MonitorConfig> = {
      autoPauseOnDeviation: true,
      deviationTolerance: 0.1,
    };
    const m = new ExecutionMonitor(config);
    m.startMonitoring(
      plan({ phases: [phase({ id: 'p', steps: [{ id: 's', content: '修改 `keep.ts`', status: 'pending' }] })] })
    );
    m.recordFileAccess('rogue.ts', 'write'); // 1 deviation / 1 action = rate 1 > 0.1
    expect(m.shouldPause()).toBe(true);
    expect(m.getProgress().status).toBe('paused');
  });

  it('shouldPause is always false when autoPause is disabled', () => {
    const m = new ExecutionMonitor({ autoPauseOnDeviation: false });
    expect(m.shouldPause()).toBe(false);
  });

  it('generateReport renders progress and deviation sections', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(
      plan({
        phases: [phase({ id: 'p', steps: [{ id: 's', content: '修改 `r.ts`', status: 'pending' }] })],
        metadata: { totalSteps: 2, completedSteps: 0, blockedSteps: 0 },
      })
    );
    m.recordFileAccess('rogue.ts', 'write');
    const report = m.generateReport();
    expect(report).toContain('计划执行报告');
    expect(report).toContain('偏离统计');
    expect(report).toContain('unexpected_file_access');
  });

  it('stopMonitoring is callable without throwing', () => {
    const m = new ExecutionMonitor();
    m.startMonitoring(plan());
    expect(() => m.stopMonitoring()).not.toThrow();
  });

  it('createExecutionMonitor builds an instance', () => {
    expect(createExecutionMonitor({ maxIterations: 3 })).toBeInstanceOf(ExecutionMonitor);
  });
});
