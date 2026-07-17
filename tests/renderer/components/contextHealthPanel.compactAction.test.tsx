// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextHealthPanel } from '../../../src/renderer/components/ContextHealthPanel';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

function makeHealth(overrides: Partial<ContextHealthState> = {}): ContextHealthState {
  return {
    currentTokens: 9500,
    maxTokens: 10000,
    usagePercent: 95,
    breakdown: { systemPrompt: 200, messages: 9100, toolResults: 200 },
    warningLevel: 'critical',
    estimatedTurnsRemaining: 1,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

// C-4：critical 块此前只提示文字，没给用户一个"现在就压缩"的出口。组件保持纯展示——
// onCompact 未传时不渲染按钮，调用方（ContextPanel）决定要不要接 IPC。
afterEach(cleanup);

describe('ContextHealthPanel — critical 「立即压缩」按钮', () => {
  it('critical + 传了 onCompact：渲染按钮，点击触发回调', () => {
    const onCompact = vi.fn();
    render(<ContextHealthPanel collapsed={false} health={makeHealth()} onCompact={onCompact} />);

    const button = screen.getByRole('button', { name: '立即压缩' });
    fireEvent.click(button);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('isCompacting=true：按钮 disabled，文案切到「压缩中…」', () => {
    render(
      <ContextHealthPanel collapsed={false} health={makeHealth()} onCompact={vi.fn()} isCompacting />,
    );

    const button = screen.getByRole('button', { name: '压缩中…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('critical 但没传 onCompact：纯展示模式，不渲染按钮', () => {
    render(<ContextHealthPanel collapsed={false} health={makeHealth()} />);
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
  });

  it('非 critical（warning）：即便传了 onCompact 也不渲染按钮', () => {
    render(
      <ContextHealthPanel
        collapsed={false}
        health={makeHealth({ warningLevel: 'warning' })}
        onCompact={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
  });
});
