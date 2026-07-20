// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskSchemas } from '../../../src/shared/ipc/schemas';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';

const typedInvokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain,
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

function logTask(): TaskRecord {
  return {
    id: 'background:task-log',
    scope: 'global',
    title: 'Log task',
    status: 'completed',
    steps: [{ title: '已完成', status: 'completed' }],
    outputRefs: [{
      id: 'task-log:ref',
      taskId: 'task-log',
      type: 'log',
      label: 'Task log',
      pathOrUrl: '/host/registered/task.log',
    }],
  };
}

describe('RunWorkbenchCards task log viewer', () => {
  beforeEach(() => {
    typedInvokeDomain.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads the registered log by task/ref id and refreshes on demand', async () => {
    typedInvokeDomain
      .mockResolvedValueOnce({
        success: true,
        data: { content: 'tail line', truncated: true, size: 70_000 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { content: 'refreshed line', truncated: false, size: 14 },
      });
    render(<TaskDashboardSummary tasks={[logTask()]} />);

    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    await screen.findByText('tail line');
    expect(screen.getByText('仅显示日志末尾')).toBeTruthy();
    expect(typedInvokeDomain).toHaveBeenCalledWith(
      BackgroundTaskSchemas.READ_TASK_LOG,
      {
        action: 'readTaskLog',
        payload: { taskId: 'task-log', refId: 'task-log:ref' },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '刷新日志' }));
    await screen.findByText('refreshed line');
    expect(typedInvokeDomain).toHaveBeenCalledTimes(2);
  });

  it('shows the existing no-output state for an empty log', async () => {
    typedInvokeDomain.mockResolvedValue({
      success: true,
      data: { content: '', truncated: false, size: 0 },
    });
    render(<TaskDashboardSummary tasks={[logTask()]} />);

    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    const viewer = await screen.findByTestId('task-log-viewer');
    await waitFor(() => expect(within(viewer).getByText('无输出')).toBeTruthy());
  });

  it('shows an error state and keeps refresh available', async () => {
    typedInvokeDomain.mockResolvedValue({
      success: false,
      error: { code: 'BACKGROUND_TASK_LOG_FILE_NOT_FOUND', message: 'missing' },
    });
    render(<TaskDashboardSummary tasks={[logTask()]} />);

    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    expect((await screen.findByRole('alert')).textContent).toContain('日志读取失败');
    expect(screen.getByRole('button', { name: '刷新日志' })).toBeTruthy();
  });
});
