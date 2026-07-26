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
    // 旧断言钉的是常驻副标题「开始一段新的协作」。左栏拥挤这条的判据是先问「这个信息该不该看」：
    // 那句是纯说明文字（标题+加号已经说完），删掉比改文案值；真有信息量的那句留在 title 里。
    // 断言整行只剩一行文本，副标题以任何形式回来都会红。
    expect(row.textContent?.trim()).toBe('新任务');
    // D2（2026-07-26 打磨批 D）：实现语义 tooltip「（纯对话，不继承项目上下文）」删除，
    // title 不应再出现。
    expect(row.getAttribute('title')).toBeNull();
    // D1：与能力区三行同一形态——裸图标无品牌色块容器，主次靠字色（zinc-100 + medium）。
    const label = row.querySelector('span.min-w-0')!;
    expect(label.className).toContain('text-zinc-100');
    expect(label.className).toContain('font-medium');
    expect(row.innerHTML).not.toContain('color-mix');
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
