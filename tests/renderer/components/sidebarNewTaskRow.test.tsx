// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarNewTaskRow } from '../../../src/renderer/components/features/sidebar/SidebarNewTaskRow';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

afterEach(cleanup);

describe('SidebarNewTaskRow', () => {
  it('triggers new-session creation and renders the task copy', () => {
    const handleNewChat = vi.fn();
    render(<SidebarNewTaskRow onClick={handleNewChat} disabled={false} loading={false} />);

    const row = screen.getByTestId('sidebar-new-task');
    fireEvent.click(row);

    expect(handleNewChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('新任务')).not.toBeNull();
    expect(screen.queryByText('开始一段新的协作')).not.toBeNull();
  });

  it('is disabled and shows loading while session creation is pending', () => {
    const handleNewChat = vi.fn();
    render(<SidebarNewTaskRow onClick={handleNewChat} disabled loading />);

    const row = screen.getByTestId('sidebar-new-task') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.querySelector('.lucide-loader-circle')).not.toBeNull();

    fireEvent.click(row);
    expect(handleNewChat).not.toHaveBeenCalled();
  });
});
