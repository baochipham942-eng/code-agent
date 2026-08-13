// @vitest-environment jsdom
// ============================================================================
// ux-round2 20a：「+」菜单 flyout 错位修复——指针落在 flyout 上时按几何坐标
// 判定它在哪个能力行的 rect 内，落到哪行就切到哪行的 flyout；
// 菜单内非行区域 150ms grace 关闭；菜单外（flyout 主体）维持现状。
// ============================================================================
import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    skills: [{ kind: 'skill', id: 'alpha', label: 'Alpha skill', description: '写作', selected: false, mounted: true, libraryId: 'builtin' }],
    connectors: [],
    mcpServers: [],
    items: [],
  }),
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: () => [],
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => null,
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';

function mockRect(el: Element, rect: { left: number; right: number; top: number; bottom: number }) {
  el.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
}

function setup() {
  const rendered = render(
    <InputAddMenu onFileSelect={vi.fn()} onSelectCapability={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '更多输入选项' }));

  const row = (kind: string) => {
    const el = rendered.container.querySelector(`[data-submenu-row="${kind}"]`);
    if (!el) throw new Error(`row ${kind} not found`);
    return el;
  };
  // 菜单 rect：行宽 200，各行纵向 40px 排列；flyout 物理上盖在右侧
  const kinds = ['experts', 'teams', 'skills', 'connectors'];
  kinds.forEach((kind, index) => {
    mockRect(row(kind), { left: 0, right: 200, top: 40 + index * 40, bottom: 80 + index * 40 });
  });
  const menuEl = row('connectors').parentElement!.parentElement!;
  mockRect(menuEl, { left: 0, right: 220, top: 0, bottom: 240 });
  return { ...rendered, row, menuEl };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('InputAddMenu flyout 几何切换（20a）', () => {
  it('指针物理上在 flyout 上、几何落在「连接器」行 → 立即切到连接器 flyout', () => {
    const { row, menuEl } = setup();

    fireEvent.mouseEnter(row('skills'));
    expect(screen.getByText('Alpha skill')).toBeTruthy();

    // 指针移到 x=250（已超出菜单列宽，物理上在 skills flyout 上），
    // 但 y 落在「连接器」行（top 160~200）——应切换到连接器 flyout。
    fireEvent.mouseMove(menuEl, { clientX: 250, clientY: 180 });
    expect(screen.queryByText('Alpha skill')).toBeNull();
    expect(row('connectors').querySelector('.absolute.bottom-0')).toBeTruthy();
  });

  it('指针落在菜单内非行区域（上传按钮/边缘）→ 150ms grace 后关闭 flyout', () => {
    vi.useFakeTimers();
    const { row, menuEl } = setup();

    fireEvent.mouseEnter(row('skills'));
    expect(screen.getByText('Alpha skill')).toBeTruthy();

    // y=10 在菜单 rect 内但不在任何行 rect 内
    fireEvent.mouseMove(menuEl, { clientX: 100, clientY: 10 });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Alpha skill')).toBeNull();
  });

  it('grace 期间指针回到某行 → 取消失败关闭，flyout 切到该行', () => {
    vi.useFakeTimers();
    const { row, menuEl } = setup();

    fireEvent.mouseEnter(row('skills'));
    fireEvent.mouseMove(menuEl, { clientX: 100, clientY: 10 });
    act(() => { vi.advanceTimersByTime(100); });
    // 150ms 未到就移到 connectors 行（几何判定），flyout 不关、直接切换
    fireEvent.mouseMove(menuEl, { clientX: 100, clientY: 180 });
    act(() => { vi.advanceTimersByTime(200); });
    // skills flyout 已关；connectors flyout 开着（行内 flyout 容器存在）
    expect(screen.queryByText('Alpha skill')).toBeNull();
    expect(row('connectors').querySelector('.absolute.bottom-0')).toBeTruthy();
  });

  it('指针在菜单容器外（flyout 主体、不在任何行 y 区间）→ 维持当前 flyout', () => {
    const { row, menuEl } = setup();

    fireEvent.mouseEnter(row('skills'));
    expect(screen.getByText('Alpha skill')).toBeTruthy();

    // flyout 向上展开探出菜单顶（y<0），几何不在任何行也不在菜单内 → 不动
    fireEvent.mouseMove(menuEl, { clientX: 300, clientY: -30 });
    expect(screen.getByText('Alpha skill')).toBeTruthy();
  });
});
