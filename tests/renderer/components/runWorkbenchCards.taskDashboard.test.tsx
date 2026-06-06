import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    language: 'zh',
    t: {
      taskPanel: {
        taskDependencySummaryWaiting: '等待 {count} 个任务',
        taskDependencySummaryUnlocking: '解锁 {count} 个任务',
        taskDependencySummarySeparator: '，',
        taskDependencyWaiting: '等待 {tasks}',
        taskDependencyUnlocks: '解锁 {tasks}',
      },
    },
  }),
}));

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

