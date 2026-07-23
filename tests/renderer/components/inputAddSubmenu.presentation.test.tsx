// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InputAddSubmenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddSubmenu';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

afterEach(cleanup);

describe('InputAddSubmenu', () => {
  const items = [
    { id: 'skill-alpha', label: 'Alpha', description: '写作工具', selected: true },
    { id: 'skill-beta', label: 'Beta', description: '研究工具' },
  ];

  it('先渲染项目，再按搜索词过滤并选择项目', () => {
    const onSelect = vi.fn();
    render(<InputAddSubmenu items={items} onSelect={onSelect} footerActions={[]} />);

    // 先确认有行，避免空状态导致后续过滤断言假绿。
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索菜单项' }), { target: { value: '研究' } });
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Beta')).toBeTruthy();

    fireEvent.click(screen.getByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it('区分没有项目与搜索无结果', () => {
    const { rerender } = render(<InputAddSubmenu items={[]} onSelect={vi.fn()} footerActions={[]} />);
    expect(screen.getByText('还没有可用项目')).toBeTruthy();

    rerender(<InputAddSubmenu items={items} onSelect={vi.fn()} footerActions={[]} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索菜单项' }), { target: { value: '不存在' } });
    expect(screen.getByText('没找到匹配项目')).toBeTruthy();
  });
});
