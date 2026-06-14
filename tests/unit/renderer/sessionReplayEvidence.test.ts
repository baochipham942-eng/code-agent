import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import { buildSessionReplayEvidenceMap } from '../../../src/renderer/utils/sessionReplayEvidence';

describe('buildSessionReplayEvidenceMap', () => {
  it('groups workflow runs and background replay refs by session', () => {
    const workflowRuns: Record<string, ScriptRunSnapshot> = {
      'run-1': {
        runId: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        goal: 'Ship project sidebar recovery',
        phases: [],
        logs: [],
        agents: [],
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      'run-without-session': {
        runId: 'run-without-session',
        status: 'completed',
        phases: [],
        logs: [],
        agents: [],
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
    };
    const tasks: Task[] = [{
      id: 'task-1',
      sessionId: 'session-1',
      source: 'agent',
      title: 'Background delivery',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      events: [],
      outputRefs: [
        {
          id: 'trace-ref',
          taskId: 'task-1',
          type: 'trace',
          label: 'trace.json',
          path: '/tmp/trace.json',
          createdAt: 2,
        },
        {
          id: 'report-ref',
          taskId: 'task-1',
          type: 'report',
          label: 'report.md',
          path: '/tmp/report.md',
          createdAt: 2,
        },
      ],
    }];

    const map = buildSessionReplayEvidenceMap(workflowRuns, tasks);

    expect(Array.from(map.keys())).toEqual(['session-1']);
    expect(map.get('session-1')).toMatchObject([
      {
        id: 'workflow:run-1:replay',
        type: 'replay',
        label: 'Workflow replay',
        sourceLabel: 'Workflow',
        actionKind: 'sessionReplay',
      },
      {
        id: 'background:task-1:trace-ref',
        type: 'trace',
        label: 'trace.json',
        sourceLabel: 'Background delivery',
        actionKind: 'file',
        pathOrUrl: '/tmp/trace.json',
      },
    ]);
  });

  it('marks http urls as openable links and opaque uris as copy targets', () => {
    const map = buildSessionReplayEvidenceMap({}, [{
      id: 'task-2',
      sessionId: 'session-2',
      source: 'agent',
      title: 'Background links',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      events: [],
      outputRefs: [
        {
          id: 'url-ref',
          taskId: 'task-2',
          type: 'replay',
          label: 'Hosted replay',
          uri: 'https://example.com/replay/1',
          createdAt: 2,
        },
        {
          id: 'opaque-ref',
          taskId: 'task-2',
          type: 'trace',
          label: 'trace handle',
          uri: 'trace://local/run-1',
          createdAt: 2,
        },
      ],
    }]);

    expect(map.get('session-2')).toMatchObject([
      {
        id: 'background:task-2:url-ref',
        actionKind: 'url',
        pathOrUrl: 'https://example.com/replay/1',
      },
      {
        id: 'background:task-2:opaque-ref',
        actionKind: 'copy',
        pathOrUrl: 'trace://local/run-1',
      },
    ]);
  });
});
