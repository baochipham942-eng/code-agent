import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryActivitySummary,
  RunOverview,
  TaskDashboardSummary,
} from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
import type { RunWorkbenchModel } from '../../../src/renderer/types/runWorkbench';

describe('MemoryActivitySummary', () => {
  it('renders memory activity rows as detail buttons when navigation is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryActivitySummary, {
        activities: [
          {
            runId: 'turn-1',
            action: 'updated',
            memoryId: 'ui_memory_activity_smoke.md',
            filename: 'ui_memory_activity_smoke.md',
            title: 'UI Memory Activity Smoke',
            reason: '更新记忆: ui_memory_activity_smoke.md',
            targetPath: '/Users/linchen/.code-agent/memory/ui_memory_activity_smoke.md',
          },
        ],
        onOpenActivity: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="memory-activity-row"');
    expect(html).toContain('<button');
    expect(html).toContain('UI Memory Activity Smoke');
    expect(html).toContain('ui_memory_activity_smoke.md');
  });
});

describe('RunOverview memory link', () => {
  it('renders a lightweight memory action when a memory handler is provided', () => {
    const model: RunWorkbenchModel = {
      run: {
        identity: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          runId: 'run-1',
          streamRunId: 'stream-1',
          status: 'completed',
        },
        status: 'completed',
        phase: '已完成',
        activeToolName: 'MemoryWrite',
      },
      loopDecisions: [],
      tools: [],
      tasks: [],
      subagents: [],
      outputs: [],
      memoryActivities: [
        {
          runId: 'run-1',
          action: 'created',
          memoryId: 'ui_memory_activity_smoke.md',
          filename: 'ui_memory_activity_smoke.md',
          title: 'UI Memory Activity Smoke',
          reason: '创建记忆',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(RunOverview, {
        model,
        onOpenMemory: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="run-overview-memory-link"');
    expect(html).toContain('<button');
    expect(html).toContain('Memory activity 1');
    expect(html).not.toContain('Tasks');
    expect(html).not.toContain('Outputs');
    expect(html).not.toContain('border-emerald-500');
  });
});

describe('TaskDashboardSummary background outputs', () => {
  it('renders dependency summary and bidirectional dependency hints', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDashboardSummary, {
        run: null,
        tasks: [
          {
            id: 'session-1:session-tasks',
            scope: 'session',
            title: '渲染依赖关系',
            status: 'blocked',
            steps: [
              {
                title: '准备数据源',
                status: 'pending',
                blockedTaskTitles: ['等待前置检查'],
              },
              {
                title: '等待前置检查',
                status: 'blocked',
                blockedByTitles: ['准备数据源'],
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain('data-testid="task-dependency-summary"');
    expect(html).toContain('1 项等待前置');
    expect(html).toContain('1 项解锁后续');
    expect(html).toContain('解锁 等待前置检查');
    expect(html).toContain('等待 准备数据源');
  });

  it('renders ledger output refs next to background agent tasks', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDashboardSummary, {
        run: null,
        tasks: [
          {
            id: 'background:agent:claude:run-1',
            scope: 'global',
            title: 'Claude Code',
            status: 'completed',
            steps: [
              { title: '已完成', status: 'completed' },
              { title: 'Claude Code log：run-1.log', status: 'completed' },
              { title: 'Claude Code final message：run-1.last.md', status: 'completed' },
            ],
            resumeHint: '最终输出：run-1.last.md',
            outputRefs: [
              {
                id: 'run-1:log',
                type: 'log',
                label: 'Claude Code log',
                pathOrUrl: '/tmp/code-agent/run-1.log',
              },
              {
                id: 'run-1:final',
                type: 'text',
                label: 'Claude Code final message',
                pathOrUrl: '/tmp/code-agent/run-1.last.md',
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain('data-testid="task-output-refs"');
    expect(html).toContain('Claude Code');
    expect(html).toContain('结果：最终输出：run-1.last.md');
    expect(html).toContain('Claude Code log');
    expect(html).toContain('/tmp/code-agent/run-1.log');
    expect(html).toContain('Claude Code final message');
    expect(html).toContain('/tmp/code-agent/run-1.last.md');
  });
});
