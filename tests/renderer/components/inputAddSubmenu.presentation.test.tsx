// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InputAddSubmenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddSubmenu';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('InputAddSubmenu', () => {
  const items = [
    { id: 'skill-alpha', label: 'Alpha', description: '写作工具', selected: true },
    { id: 'skill-beta', label: 'Beta', description: '研究工具' },
  ];

  it('先渲染项目，再按搜索词过滤并选择项目', () => {
    const onSelect = vi.fn();
    render(<InputAddSubmenu scope="skills" items={items} onSelect={onSelect} footerActions={[]} />);

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
    const { rerender } = render(<InputAddSubmenu scope="skills" items={[]} onSelect={vi.fn()} footerActions={[]} />);
    expect(screen.getByText('还没有可用项目')).toBeTruthy();

    rerender(<InputAddSubmenu scope="skills" items={items} onSelect={vi.fn()} footerActions={[]} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索菜单项' }), { target: { value: '不存在' } });
    expect(screen.getByText('没找到匹配项目')).toBeTruthy();
  });

  it('置顶后排到第一位，且不触发选择', () => {
    const onSelect = vi.fn();
    const { container } = render(<InputAddSubmenu scope="skills" items={items} onSelect={onSelect} footerActions={[]} />);

    const rows = () => Array.from(container.querySelectorAll('[data-testid^="input-add-submenu-item-"]'));
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '置顶' })[1]);

    expect(rows()[0]?.textContent).toContain('Beta');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('选中过的项目会在下次渲染时优先于未选中的同类项目', () => {
    const firstRender = render(<InputAddSubmenu scope="skills" items={items} onSelect={vi.fn()} footerActions={[]} />);
    fireEvent.click(screen.getByText('Beta'));
    firstRender.unmount();

    const { container } = render(<InputAddSubmenu scope="skills" items={items} onSelect={vi.fn()} footerActions={[]} />);
    const rows = Array.from(container.querySelectorAll('[data-testid^="input-add-submenu-item-"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Beta');
  });

  it('搜索时名称命中仍优先于描述命中，即使描述命中项被置顶', () => {
    const searchItems = [
      { id: 'name-match', label: 'Research', description: '普通描述' },
      { id: 'description-match', label: 'Other', description: 'Research 工具' },
    ];
    const { container } = render(<InputAddSubmenu scope="skills" items={searchItems} onSelect={vi.fn()} footerActions={[]} />);
    fireEvent.click(screen.getAllByRole('button', { name: '置顶' })[1]);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索菜单项' }), { target: { value: 'research' } });

    const rows = Array.from(container.querySelectorAll('[data-testid^="input-add-submenu-item-"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Research');
  });

  it('localStorage 不可用时照常渲染并按原始顺序退化', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    });

    const { container } = render(<InputAddSubmenu scope="skills" items={items} onSelect={vi.fn()} footerActions={[]} />);
    const rows = Array.from(container.querySelectorAll('[data-testid^="input-add-submenu-item-"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Alpha');
    expect(rows[1]?.textContent).toContain('Beta');
  });
});
