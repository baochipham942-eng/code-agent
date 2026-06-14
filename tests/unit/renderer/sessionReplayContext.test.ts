import { describe, expect, it } from 'vitest';
import { buildSessionReplayContext } from '../../../src/renderer/utils/sessionReplayContext';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';

describe('buildSessionReplayContext', () => {
  it('collects workflow runs, background tasks, and replay evidence for one session', () => {
    const workflowRuns: Record<string, ScriptRunSnapshot> = {
      'run-1': {
        runId: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        goal: 'Recover session workflow',
        phases: ['Build'],
        logs: ['done'],
        agents: [],
        runningCount: 0,
        doneCount: 1,
        errorCount: 0,
      },
      'run-2': {
        runId: 'run-2',
        sessionId: 'session-2',
        status: 'running',
        goal: 'Other workflow',
        phases: [],
        logs: [],
        agents: [],
        runningCount: 1,
        doneCount: 0,
        errorCount: 0,
      },
    };
    const tasks: Task[] = [
      {
        id: 'task-1',
        sessionId: 'session-1',
        source: 'agent',
        title: 'Background trace',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        events: [],
        outputRefs: [{
          id: 'trace-ref',
          taskId: 'task-1',
          type: 'trace',
          label: 'trace.json',
          path: '/tmp/trace.json',
          createdAt: 2,
        }],
      },
      {
        id: 'task-2',
        sessionId: 'session-2',
        source: 'agent',
        title: 'Other task',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        events: [],
        outputRefs: [],
      },
    ];

    const context = buildSessionReplayContext('session-1', workflowRuns, tasks);

    expect(context.workflowRuns.map((run) => run.runId)).toEqual(['run-1']);
    expect(context.backgroundTasks.map((task) => task.id)).toEqual(['task-1']);
    expect(context.evidence.map((item) => item.title)).toEqual([
      'Workflow replay · 已完成 · Recover session workflow',
      'Trace · trace.json · Background trace · /tmp/trace.json',
    ]);
  });

  it('returns an empty context without a session id', () => {
    expect(buildSessionReplayContext(null, {}, [])).toEqual({
      workflowRuns: [],
      backgroundTasks: [],
      evidence: [],
    });
  });
});
