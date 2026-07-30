// @vitest-environment jsdom
//
// DecisionCard（决策卡统一骨架）行为门：
// - 未选中时确认禁用，选中后可确认；底部 ghost 取消 + primary 确认；
// - 数字键 1-N 选中、Enter 确认、Esc 取消（输入框聚焦时不拦截）；
// - danger 变体渲染警示行与红边。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GitBranch } from 'lucide-react';

import { DecisionCard, type DecisionOption } from '../../../src/renderer/components/DecisionCard';

const OPTIONS: DecisionOption[] = [
  { id: 'approve', label: '批准启动', description: '按计划启动' },
  { id: 'reject', label: '拒绝', description: '取消这次启动' },
];

function renderCard(overrides: Partial<Parameters<typeof DecisionCard>[0]> = {}) {
  const props: Parameters<typeof DecisionCard>[0] = {
    icon: <GitBranch className="w-4 h-4" />,
    title: '启动审批',
    question: '启动 Swarm · 2 个任务？',
    options: OPTIONS,
    selectedId: null,
    onSelect: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    confirmLabel: '确认',
    cancelLabel: '取消',
    ...overrides,
  };
  render(<DecisionCard {...props} />);
  return props;
}

describe('DecisionCard 统一骨架', () => {
  afterEach(() => cleanup());

  it('未选中选项时确认禁用，选中后可点', () => {
    const props = renderCard();

    const confirm = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    cleanup();
    const selected = renderCard({ ...props, selectedId: 'approve' });
    const enabledConfirm = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
    expect(enabledConfirm.disabled).toBe(false);

    fireEvent.click(enabledConfirm);
    expect(selected.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('点击选项行触发 onSelect', () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /批准启动/ }));
    expect(props.onSelect).toHaveBeenCalledWith('approve');
  });

  it('数字键选中选项、Enter 确认、Esc 取消', () => {
    const props = renderCard({ selectedId: 'reject' });

    fireEvent.keyDown(window, { key: '1' });
    expect(props.onSelect).toHaveBeenCalledWith('approve');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('未选中时 Enter 不触发确认', () => {
    const props = renderCard();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('输入框聚焦时键盘不拦截', () => {
    const props = renderCard({
      selectedId: 'approve',
      footerExtra: <input aria-label="反馈" />,
    });

    const input = screen.getByLabelText('反馈');
    fireEvent.keyDown(input, { key: '1' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('danger 变体渲染警示行与红边', () => {
    renderCard({
      tone: 'danger',
      dangerWarning: '这是一个危险命令：递归删除文件，可能导致数据丢失',
    });

    expect(screen.getByText(/这是一个危险命令/)).toBeTruthy();
    const card = screen.getByTestId('decision-card').firstElementChild as HTMLElement;
    expect(card.className).toContain('border-red-500');
  });

  it('ghost 取消按钮触发 onCancel', () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});
