import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return {
    useI18n: () => ({
      language: 'zh',
      t: {
        ...zh,
        taskPanel: {
          ...zh.taskPanel,
          taskDependencySummaryWaiting: '等待 {count} 个任务',
          taskDependencySummaryUnlocking: '解锁 {count} 个任务',
          taskDependencySummarySeparator: '，',
          taskDependencyWaiting: '等待 {tasks}',
          taskDependencyUnlocks: '解锁 {tasks}',
        },
      },
    }),
  };
});

function makeRun(status: string, phase = '执行中', activeToolName?: string) {
  return {
    identity: { sessionId: 's1', turnId: 't1', runId: 'r1', streamRunId: null, status },
    status,
    phase,
    activeToolName,
  } as never;
}

describe('TaskDashboardSummary 运行中空态（UI 审计 #8）', () => {
  it('tasks 为空但 run 处于 live 状态时显示进行中信号，而非「暂无任务」', () => {
    for (const status of ['planning', 'running', 'using_tools', 'verifying', 'waiting_approval']) {
      const html = renderToStaticMarkup(
        React.createElement(TaskDashboardSummary, {
          tasks: [],
          run: makeRun(status, '规划任务'),
        }),
      );
      expect(html, status).toContain('data-testid="active-run-placeholder"');
      expect(html, status).toContain('规划任务');
      expect(html, status).not.toContain('暂无任务');
    }
  });

  it('live 空态显示当前工具名', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDashboardSummary, {
        tasks: [],
        run: makeRun('using_tools', '调用工具', 'bash'),
      }),
    );
    expect(html).toContain('bash');
  });

  it('tasks 为空且 run 已终态/缺失时仍显示「暂无任务」', () => {
    for (const run of [null, makeRun('completed', '已完成'), makeRun('cancelled', '已取消'), makeRun('blocked', '已阻塞')]) {
      const html = renderToStaticMarkup(
        React.createElement(TaskDashboardSummary, { tasks: [], run }),
      );
      expect(html).toContain('暂无任务');
      expect(html).not.toContain('active-run-placeholder');
    }
  });
});

describe('TaskDashboardSummary', () => {
  it('labels non-current tasks as background tasks instead of other runs', () => {
    const backgroundTask: TaskRecord = {
      id: 'background:loop-1',
      scope: 'global',
      title: '循环 · 检查中',
      status: 'completed',
      steps: [{ title: '已完成', status: 'completed' }],
      ownerRunId: null,
      sourceThreadId: 'session-2',
      resumeHint: '已完成 2 轮',
    };

    const html = renderToStaticMarkup(
      React.createElement(TaskDashboardSummary, {
        tasks: [backgroundTask],
        run: null,
      }),
    );

    expect(html).toContain('当前对话暂无任务');
    expect(html).toContain('后台任务');
    expect(html).not.toContain('其他运行');
  });
});

