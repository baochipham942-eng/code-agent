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

  it('contentEditable（neo composer）聚焦时数字键/Enter/Esc 都不吃（review P1）', () => {
    const props = renderCard({ selectedId: 'approve' });

    // jsdom 未实现 isContentEditable，手动挂属性模拟真实浏览器行为
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    Object.defineProperty(composer, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(composer);

    fireEvent.keyDown(composer, { key: '1' });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();

    composer.remove();
  });

  it('textarea 内 Esc：不取消但吞掉冒泡（防 ChatView Esc+Esc rewind）（review P1）', () => {
    const props = renderCard({
      footerExtra: <textarea aria-label="反馈" />,
    });
    // 卡片自己的监听在 window capture；bubble 阶段的 window 监听若能收到，
    // 说明 Esc 冒泡穿了（ChatView 的 Esc+Esc 就会接着触发）
    const bubbleSpy = vi.fn();
    window.addEventListener('keydown', bubbleSpy);

    const textarea = screen.getByLabelText('反馈');
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(bubbleSpy).not.toHaveBeenCalled();

    window.removeEventListener('keydown', bubbleSpy);
  });

  it('submitting 期间 Esc/Enter 只吞不动作（防在途双发 IPC）（review P1）', () => {
    const props = renderCard({ selectedId: 'approve', submitting: true });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});
