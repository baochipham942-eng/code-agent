import { describe, expect, it } from 'vitest';
import {
  buildGlobalTaskRecords,
  buildLedgerTaskRecords,
  buildWorkflowSubagentViews,
  buildWorkflowTaskRecord,
} from '../../../src/renderer/hooks/useRunWorkbenchModel';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import type { SessionState } from '../../../src/renderer/stores/taskStore';
import type { Task } from '../../../src/shared/contract/backgroundTask';

describe('buildGlobalTaskRecords', () => {
  it('does not mirror the current session into background tasks', () => {
    const tasks = buildGlobalTaskRecords({
      currentSessionId: 'session-current',
      sessionStates: {
        'session-current': { status: 'running' },
        'other-123456': { status: 'running' },
        idle: { status: 'idle' },
      } satisfies Record<string, SessionState>,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'global:other-123456',
      scope: 'global',
      title: '会话 other-12',
      status: 'in_progress',
      ownerRunId: null,
      sourceThreadId: 'other-123456',
    });
  });
});

describe('buildLedgerTaskRecords', () => {
  it('projects only current-session agent engine ledger status and output refs for TaskPanel', () => {
    const tasks = buildLedgerTaskRecords([
      makeLedgerTask({
        id: 'agent:codex:run-1',
        sessionId: 'session-1',
        title: 'Codex CLI',
        status: 'stalled',
        progress: { label: 'Codex CLI slow start' },
        metadata: { logPath: '/tmp/code-agent/run-1.log' },
      }),
      makeLedgerTask({
        id: 'agent:claude:run-2',
        sessionId: 'session-1',
        title: 'Claude Code',
        status: 'completed',
        durationMs: 12_000,
        outputRefs: [
          {
            id: 'run-2:log',
            taskId: 'agent:claude:run-2',
            type: 'log',
            label: 'Claude Code log',
            path: '/tmp/code-agent/run-2.log',
            size: 0,
            createdAt: 120,
          },
          {
            id: 'run-2:final',
            taskId: 'agent:claude:run-2',
            type: 'text',
            label: 'Claude Code final message',
            path: '/tmp/code-agent/run-2.last.md',
            createdAt: 130,
          },
        ],
      }),
      makeLedgerTask({
        id: 'agent:codex:run-3',
        sessionId: 'session-1',
        title: 'Codex CLI',
        status: 'failed',
        failure: { message: 'Codex CLI exited with code 1', exitCode: 1, category: 'agent_engine' },
      }),
      makeLedgerTask({
        id: 'agent:codex:run-4',
        sessionId: 'session-1',
        title: 'Codex CLI cancelled',
        status: 'cancelled',
      }),
      makeLedgerTask({
        id: 'agent:other:run-5',
        sessionId: 'session-2',
        title: 'Other session run',
        status: 'completed',
      }),
    ], 'session-1');

    expect(tasks[0]).toMatchObject({
      id: 'background:agent:codex:run-1',
      status: 'in_progress',
      resumeHint: 'Codex CLI slow start',
      outputRefs: [
        {
          type: 'log',
          label: '运行日志',
          pathOrUrl: '/tmp/code-agent/run-1.log',
        },
      ],
    });
    expect(tasks[0].steps.map((step) => step.title)).toEqual([
      '启动变慢：Codex CLI slow start',
      '运行日志：run-1.log',
    ]);

    expect(tasks[1]).toMatchObject({
      status: 'completed',
      resumeHint: '最终输出：run-2.last.md',
      outputRefs: [
        {
          type: 'log',
          label: 'Claude Code log',
          pathOrUrl: '/tmp/code-agent/run-2.log',
          size: 0,
        },
        {
          type: 'text',
          label: 'Claude Code final message',
          pathOrUrl: '/tmp/code-agent/run-2.last.md',
        },
      ],
    });
    expect(tasks[1].steps.map((step) => step.title)).toEqual([
      '已完成',
      '12s',
      'Claude Code log：run-2.log',
      'Claude Code final message：run-2.last.md',
    ]);

    expect(tasks[2]).toMatchObject({
      status: 'blocked',
      resumeHint: 'Codex CLI exited with code 1',
    });
    expect(tasks[3]).toMatchObject({
      status: 'cancelled',
    });
    expect(tasks[3].steps.map((step) => step.title)).toEqual(['已取消']);
    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.title)).not.toContain('Other session run');
  });

  it('does not show ledger tasks without a current session', () => {
    expect(buildLedgerTaskRecords([
      makeLedgerTask({
        id: 'agent:codex:run-1',
        sessionId: 'session-1',
      }),
    ], null)).toEqual([]);
  });

  it('uses durable recovery plan summaries as resume hints', () => {
    const tasks = buildLedgerTaskRecords([
      makeLedgerTask({
        id: 'shell:dev-server',
        sessionId: 'session-1',
        title: 'npm run dev',
        status: 'orphaned',
        failure: {
          message: 'Task process was not recovered after restart; log is available only',
          category: 'dead_log_only',
        },
        metadata: {
          recoveryPlan: {
            status: 'dead-log-only',
            summary: '应用重启后没有找到运行进程，保留日志，可打开日志后重跑。',
            recommendedActions: ['open_log', 'retry'],
          },
        },
        outputRefs: [{
          id: 'shell:dev-server:log',
          taskId: 'shell:dev-server',
          type: 'log',
          path: '/tmp/dev.log',
          createdAt: 10,
        }],
      }),
    ], 'session-1');

    expect(tasks[0]).toMatchObject({
      status: 'blocked',
      resumeHint: '应用重启后没有找到运行进程，保留日志，可打开日志后重跑。',
    });
  });
});

describe('buildWorkflowTaskRecord', () => {
  it('projects workflow snapshot into the TaskPanel task model', () => {
    const snapshot: ScriptRunSnapshot = {
      runId: 'wf-1',
      sessionId: 'session-1',
      status: 'running',
      goal: '整理产品闭环',
      scriptHash: 'h',
      phases: ['audit'],
      currentPhase: 'audit',
      logs: [],
      agents: [
        {
          id: 'wf-1-a1',
          label: 'Runtime',
          status: 'running',
          promptPreview: '审计 workflow',
          model: 'kimi-k2.5',
        },
        {
          id: 'wf-1-a2',
          label: 'UX',
          status: 'done',
          resultPreview: '发现状态口径分裂',
          cached: true,
        },
      ],
      runningCount: 1,
      doneCount: 1,
      errorCount: 0,
      startedAt: 100,
    };

    expect(buildWorkflowTaskRecord(snapshot)).toMatchObject({
      id: 'workflow:wf-1',
      scope: 'session',
      title: 'Workflow: 整理产品闭环',
      status: 'in_progress',
      ownerRunId: 'wf-1',
      sourceThreadId: 'session-1',
      steps: [
        { title: '执行中：audit', status: 'in_progress' },
        { title: '1 执行中 · 1 已完成', status: 'in_progress' },
      ],
      outputRefs: [
        { type: 'replay', label: 'Workflow replay' },
      ],
    });

    expect(buildWorkflowSubagentViews(snapshot)).toMatchObject([
      {
        id: 'workflow:wf-1:wf-1-a1',
        parentRunId: 'wf-1',
        role: 'Runtime',
        model: 'kimi-k2.5',
        status: 'running',
        inputSummary: '审计 workflow',
      },
      {
        id: 'workflow:wf-1:wf-1-a2',
        parentRunId: 'wf-1',
        role: 'UX',
        status: 'completed',
        lastOutput: '发现状态口径分裂',
      },
    ]);
  });
});

function makeLedgerTask(overrides: Partial<Task>): Task {
  return {
    id: 'agent:task',
    kind: 'agent_engine',
    sessionId: 'session-1',
    runId: 'run-1',
    source: 'agent_engine',
    title: 'Agent Engine',
    summary: 'Agent engine run',
    status: 'running',
    createdAt: 100,
    updatedAt: 100,
    startedAt: 100,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}
