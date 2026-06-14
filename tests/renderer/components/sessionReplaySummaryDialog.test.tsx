import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionReplaySummaryDialog } from '../../../src/renderer/components/features/sidebar/SessionReplaySummaryDialog';

describe('SessionReplaySummaryDialog', () => {
  it('renders replay summary and incomplete telemetry reasons', () => {
    const html = renderToStaticMarkup(
      <SessionReplaySummaryDialog
        sessionTitle="Alma Project / Session Organization"
        onClose={vi.fn()}
        onOpenEvidence={vi.fn()}
        workflowRuns={[{
          runId: 'workflow-run-1',
          sessionId: 'session-1',
          status: 'running',
          goal: 'Recover project delivery',
          phases: ['Research', 'Implementation'],
          currentPhase: 'Implementation',
          logs: [],
          agents: [
            {
              id: 'agent-1',
              label: 'Reviewer',
              phase: 'Research',
              model: 'gpt-5',
              promptPreview: 'Review the session organization plan',
              status: 'running',
            },
            {
              id: 'agent-2',
              label: 'Builder',
              phase: 'Implementation',
              model: 'gpt-5-mini',
              status: 'done',
              resultPreview: 'patched sidebar',
            },
          ],
          runningCount: 1,
          doneCount: 1,
          errorCount: 0,
          startedAt: 50,
          durationMs: 12_000,
        }, {
          runId: 'workflow-run-new',
          sessionId: 'session-1',
          status: 'completed',
          goal: 'Recent follow-up',
          phases: ['Verify'],
          logs: [],
          agents: [],
          runningCount: 0,
          doneCount: 0,
          errorCount: 0,
          startedAt: 100,
          finishedAt: 120,
        }, {
          runId: 'workflow-run-old',
          sessionId: 'session-1',
          status: 'completed',
          goal: 'Older follow-up',
          phases: [],
          logs: [],
          agents: [],
          runningCount: 0,
          doneCount: 0,
          errorCount: 0,
          startedAt: 25,
        }, {
          runId: 'workflow-run-hidden',
          sessionId: 'session-1',
          status: 'completed',
          goal: 'Hidden follow-up',
          phases: [],
          logs: [],
          agents: [],
          runningCount: 0,
          doneCount: 0,
          errorCount: 0,
          startedAt: 10,
        }]}
        backgroundTasks={[{
          id: 'task-1',
          sessionId: 'session-1',
          source: 'agent',
          title: 'Background delivery',
          status: 'completed',
          createdAt: 1,
          updatedAt: 2,
          durationMs: 2500,
          events: [
            {
              id: 'event-1',
              taskId: 'task-1',
              type: 'task_started',
              status: 'running',
              message: 'running background delivery',
              timestamp: 2,
            },
            {
              id: 'event-2',
              taskId: 'task-1',
              type: 'output_added',
              status: 'completed',
              message: 'trace file written',
              timestamp: 3,
            },
          ],
          outputRefs: [
            {
              id: 'trace-ref',
              taskId: 'task-1',
              type: 'trace',
              label: 'trace.json',
              path: '/tmp/trace.json',
              createdAt: 2,
            },
          ],
        }, {
          id: 'task-recent',
          sessionId: 'session-1',
          source: 'workflow',
          title: 'Recent background task',
          status: 'running',
          createdAt: 9,
          updatedAt: 9,
          startedAt: 9,
          events: [],
          outputRefs: [],
        }, {
          id: 'task-old',
          sessionId: 'session-1',
          source: 'agent',
          title: 'Older background task',
          status: 'completed',
          createdAt: 0,
          updatedAt: 1,
          events: [],
          outputRefs: [],
        }, {
          id: 'task-hidden',
          sessionId: 'session-1',
          source: 'agent',
          title: 'Hidden background task',
          status: 'completed',
          createdAt: 0,
          updatedAt: 0,
          events: [],
          outputRefs: [],
        }]}
        evidence={[{
          id: 'background:task-1:trace-ref',
          sessionId: 'session-1',
          type: 'trace',
          label: 'trace.json',
          sourceLabel: 'Background delivery',
          title: 'Trace · trace.json · Background delivery',
          actionKind: 'file',
          pathOrUrl: '/tmp/trace.json',
        }, {
          id: 'workflow:workflow-run-new:replay',
          sessionId: 'session-1',
          type: 'replay',
          label: 'Workflow replay',
          sourceLabel: 'Workflow',
          title: 'Workflow replay · Recent follow-up',
          actionKind: 'sessionReplay',
        }, {
          id: 'background:task-recent:trace-ref',
          sessionId: 'session-1',
          type: 'trace',
          label: 'task-recent-trace.json',
          sourceLabel: 'Recent background task',
          title: 'Trace · task-recent-trace.json · Recent background task',
          actionKind: 'file',
          pathOrUrl: '/tmp/task-recent-trace.json',
        }, {
          id: 'background:task-old:replay-ref',
          sessionId: 'session-1',
          type: 'replay',
          label: 'task-old-replay.json',
          sourceLabel: 'Older background task',
          title: 'Replay · task-old-replay.json · Older background task',
          actionKind: 'file',
          pathOrUrl: '/tmp/task-old-replay.json',
        }, {
          id: 'background:task-hidden:trace-ref',
          sessionId: 'session-1',
          type: 'trace',
          label: 'hidden-trace.json',
          sourceLabel: 'Hidden background task',
          title: 'Trace · hidden-trace.json · Hidden background task',
          actionKind: 'file',
          pathOrUrl: '/tmp/hidden-trace.json',
        }]}
        replay={{
          sessionId: 'session-1',
          traceSource: 'session_replay',
          traceIdentity: {
            traceId: 'session:session-1',
            traceSource: 'session_replay',
            source: 'session_replay',
            sessionId: 'session-1',
            replayKey: 'session-1',
          },
          dataSource: 'telemetry',
          turns: [
            {
              turnNumber: 1,
              turnType: 'user',
              blocks: [
                {
                  type: 'user',
                  content: '请研究 Alma 会话组织',
                  timestamp: 1,
                },
                {
                  type: 'model_call',
                  content: 'model call',
                  timestamp: 2,
                  modelDecision: {
                    id: 'model-1',
                    provider: 'openai',
                    model: 'gpt-5',
                    resolvedModel: 'gpt-5',
                    toolCallCount: 1,
                    inputTokens: 120,
                    outputTokens: 80,
                    latencyMs: 1500,
                  },
                },
                {
                  type: 'tool_call',
                  content: 'Read',
                  timestamp: 3,
                  toolCall: {
                    id: 'tool-1',
                    name: 'Read',
                    args: { file: 'docs/research.md' },
                    success: true,
                    duration: 250,
                    category: 'Read',
                  },
                },
              ],
              inputTokens: 120,
              outputTokens: 80,
              durationMs: 65_000,
              startTime: 1,
            },
            {
              turnNumber: 2,
              turnType: 'iteration',
              blocks: [
                {
                  type: 'tool_call',
                  content: 'Bash',
                  timestamp: 4,
                  toolCall: {
                    id: 'tool-2',
                    name: 'Bash',
                    args: { command: 'npm test' },
                    success: false,
                    duration: 500,
                    category: 'Bash',
                  },
                },
              ],
              inputTokens: 10,
              outputTokens: 5,
              durationMs: 500,
              startTime: 4,
            },
          ],
          summary: {
            totalTurns: 3,
            toolDistribution: {
              Read: 2,
              Edit: 1,
              Write: 0,
              Bash: 0,
              Search: 0,
              Web: 0,
              Agent: 0,
              Skill: 0,
              Other: 0,
            },
            thinkingRatio: 0,
            selfRepairChains: 0,
            totalDurationMs: 65_000,
            telemetryCompleteness: {
              turnCount: 3,
              modelCallCount: 1,
              toolCallCount: 3,
              eventCount: 0,
              hasModelDecisions: true,
              hasToolSchemas: true,
              hasPermissionTrace: false,
              hasContextCompressionEvents: false,
              hasSubagentTelemetry: false,
              incompleteReasons: ['missing_event_trace'],
            },
          },
        }}
      />,
    );

    expect(html).toContain('Replay');
    expect(html).toContain('Alma Project / Session Organization');
    expect(html).toContain('Turns');
    expect(html).toContain('3');
    expect(html).toContain('Read 2');
    expect(html).toContain('Edit 1');
    expect(html).toContain('1 分 5 秒');
    expect(html).toContain('Replay 数据不完整');
    expect(html).toContain('missing_event_trace');
    expect(html).toContain('Timeline');
    expect(html).toContain('第 1 轮');
    expect(html).toContain('3 blocks');
    expect(html).toContain('模型 gpt-5');
    expect(html).toContain('200 tokens');
    expect(html).toContain('工具 Read');
    expect(html).toContain('成功 · 250 ms');
    expect(html).toContain('第 2 轮');
    expect(html).toContain('工具失败 Bash');
    expect(html).toContain('失败 · 500 ms');
    expect(html).toContain('Workflow / Background');
    expect(html).toContain('4 workflow · 4 task · 5 evidence');
    expect(html.indexOf('Workflow: Recent follow-up')).toBeLessThan(html.indexOf('Workflow: Recover project delivery'));
    expect(html).toContain('run workflow-run-new');
    expect(html).toContain('aria-label="聚焦 workflow workflow-run-new"');
    expect(html).toContain('aria-label="Workflow workflow-run-new 证据"');
    expect(html).toContain('Workflow replay');
    expect(html).toContain('Workflow: Recover project delivery');
    expect(html).toContain('执行中：Implementation');
    expect(html).toContain('run workflow-run-1');
    expect(html).toContain('1 running · 1 done');
    expect(html).toContain('Phases：Research · Implementation');
    expect(html).toContain('另有 1 个 workflow run');
    expect(html).toContain('Reviewer');
    expect(html).toContain('执行中');
    expect(html).toContain('Research · gpt-5');
    expect(html).toContain('Review the session organization plan');
    expect(html).toContain('Builder');
    expect(html).toContain('完成');
    expect(html).toContain('Implementation · gpt-5-mini');
    expect(html).toContain('patched sidebar');
    expect(html.indexOf('Recent background task')).toBeLessThan(html.indexOf('Background delivery'));
    expect(html).toContain('aria-label="聚焦 background task task-recent"');
    expect(html).toContain('aria-label="Background task task-recent 证据"');
    expect(html).toContain('aria-label="打开证据 Trace · task-recent-trace.json"');
    expect(html).toContain('Background delivery');
    expect(html).toContain('task task-1');
    expect(html).toContain('aria-label="Background task task-1 证据"');
    expect(html).toContain('另有 1 个 background task');
    expect(html).toContain('Trace · trace.json');
    expect(html).toContain('aria-label="打开证据 Trace · trace.json"');
    expect(html).toContain('其他证据');
    expect(html).toContain('Trace · hidden-trace.json');
    expect(html).toContain('task_started · running');
    expect(html).toContain('running background delivery');
    expect(html).toContain('output_added · completed');
    expect(html).toContain('trace file written');
  });

  it('renders an empty timeline fallback when turns are unavailable', () => {
    const html = renderToStaticMarkup(
      <SessionReplaySummaryDialog
        sessionTitle="Empty Replay"
        onClose={vi.fn()}
        replay={{
          sessionId: 'session-empty',
          traceSource: 'session_replay',
          traceIdentity: {
            traceId: 'session:session-empty',
            traceSource: 'session_replay',
            source: 'session_replay',
            sessionId: 'session-empty',
            replayKey: 'session-empty',
          },
          dataSource: 'transcript',
          turns: [],
          summary: {
            totalTurns: 0,
            toolDistribution: {
              Read: 0,
              Edit: 0,
              Write: 0,
              Bash: 0,
              Search: 0,
              Web: 0,
              Agent: 0,
              Skill: 0,
              Other: 0,
            },
            thinkingRatio: 0,
            selfRepairChains: 0,
            totalDurationMs: 0,
          },
        }}
      />,
    );

    expect(html).toContain('Replay 暂无 turn 明细');
  });
});
