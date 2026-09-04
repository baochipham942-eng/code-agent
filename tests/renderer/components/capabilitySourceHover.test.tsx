// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CapabilitySourceHover } from '../../../src/renderer/components/features/chat/ChatInput/CapabilitySourceHover';

function renderHover() {
  return render(
    <div>
      <CapabilitySourceHover testId="source-card" card={<button type="button">去能力中心连接</button>}>
        <span data-testid="trigger">图标</span>
      </CapabilitySourceHover>
      <span data-testid="outside">别处</span>
    </div>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('CapabilitySourceHover', () => {
  it('鼠标悬停出卡、移开即走', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.mouseEnter(root);
    expect(screen.getByTestId('source-card')).toBeTruthy();

    fireEvent.mouseLeave(root);
    expect(screen.queryByTestId('source-card')).toBeNull();
  });

  it('没按够时长就松手，不出卡', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.touchStart(root);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.touchEnd(root);
    act(() => { vi.advanceTimersByTime(400); });

    expect(screen.queryByTestId('source-card')).toBeNull();
  });

  it('触屏长按开的卡，松手后留在屏上——否则卡里的出口点不到', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.touchStart(root);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId('source-card')).toBeTruthy();

    fireEvent.touchEnd(root);
    expect(screen.getByTestId('source-card')).toBeTruthy();
    // 移动端浏览器会合成 mouseleave，长按开的卡不能跟着它关
    fireEvent.mouseLeave(root);
    expect(screen.getByTestId('source-card')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去能力中心连接' })).toBeTruthy();
  });

  it('长按开的卡点卡外收起，点卡里不收（否则按不到出口）', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.touchStart(root);
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.touchEnd(root);

    fireEvent.pointerDown(screen.getByRole('button', { name: '去能力中心连接' }));
    expect(screen.getByTestId('source-card')).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('source-card')).toBeNull();
  });

  // ai-review 第七轮 Important 2：卡与触发器之间的 8px 间距如果用 margin 做，
  // 鼠标从 chip 移进卡先经过空隙 → 根 div mouseleave → 卡半路卸载，出口永远点不到。
  // 间距必须是外壳的 padding（在 hover 判定区内）。jsdom 没有真指针轨迹，
  // 用结构断言咬住：外壳带 pb-*、整条类串里没有 mb-*。
  it('卡与触发器之间的间距是外壳 padding 不是 margin——margin 的空隙会让鼠标路径上的卡提前关掉', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.mouseEnter(root);
    const shell = screen.getByTestId('source-card');
    expect(shell.className).toContain('pb-');
    expect(shell.className).not.toContain('mb-');
  });

  // 键盘路径：focus 从 chip 移进卡内按钮不算失焦（relatedTarget 还在根内），
  // 否则键盘用户永远到不了卡里的出口
  it('焦点在根内移动（chip → 卡内按钮）不收卡，移出根才收', () => {
    const { container } = renderHover();
    const root = container.querySelector('.relative')!;

    fireEvent.focus(root);
    const button = screen.getByRole('button', { name: '去能力中心连接' });
    fireEvent.blur(root, { relatedTarget: button });
    expect(screen.getByTestId('source-card')).toBeTruthy();

    fireEvent.blur(root, { relatedTarget: screen.getByTestId('outside') });
    expect(screen.queryByTestId('source-card')).toBeNull();
  });
});
