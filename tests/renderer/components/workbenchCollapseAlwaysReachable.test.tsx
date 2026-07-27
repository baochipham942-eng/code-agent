// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// 右栏开关：两态必须**同住顶栏一个位置**，且任何一档都够得着。
//
// 两个真实症状同一个根因（2026-07-27 产品负责人连报）：
//  ① 收起钮原本挂在 WorkbenchTabs 工具条上，而该工具条在"一个 view 都没开"时整条早退不画
//     ⇒ 右栏关不掉（顶栏那颗当时只在已收起态画，是拿来展开的）。
//  ② 把它补回工具条后，开关在"顶栏那一行"和"面板头那一行"之间跳 ——「为什么纵向位置会变？」
// 结论：一个开关的两态不该分居两处。这条门钉的是行为：两态都在顶栏、都点得动。
// ---------------------------------------------------------------------------
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined), on: () => () => {} },
}));
vi.mock('../../../src/renderer/components/SessionActionsMenu', () => ({
  SessionActionsMenu: () => null,
}));

import { TitleBar } from '../../../src/renderer/components/TitleBar';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  useAppStore.setState({ language: 'zh', workbenchCollapsed: false, workbenchTabs: [], activeWorkbenchTab: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', workbenchCollapsed: false, workbenchTabs: [] });
});

describe('右栏开关（顶栏单点，两态同位）', () => {
  it('展开态：顶栏就有收起入口，收的是整栏而非关掉视图（不依赖面板头那条工具条）', () => {
    useAppStore.setState({ workbenchCollapsed: false, workbenchTabs: ['files'], activeWorkbenchTab: 'files' });
    render(<TitleBar />);

    fireEvent.click(screen.getByTestId('titlebar-collapse-workbench'));

    expect(useAppStore.getState().workbenchCollapsed).toBe(true);
    // 面板本身留着，展开后回到原来那个视图。
    expect(useAppStore.getState().workbenchTabs).toEqual(['files']);
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');
  });

  it('一个 view 都没开时收起入口照样在（它不挂在"有内容才渲染"的分支上）', () => {
    useAppStore.setState({ workbenchCollapsed: false, workbenchTabs: [], activeWorkbenchTab: null });
    render(<TitleBar />);

    expect(screen.getByTestId('titlebar-collapse-workbench')).toBeTruthy();
  });

  it('收起态：同一位置翻成展开入口，点击展开且不顺手塞 view', () => {
    useAppStore.setState({ workbenchCollapsed: true });
    render(<TitleBar />);

    fireEvent.click(screen.getByTestId('titlebar-expand-workbench'));
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    expect(useAppStore.getState().workbenchTabs).toEqual([]);
  });

  it('两态的按钮是同一个槽位：都在顶栏右端那一组里，位置不随状态变', () => {
    useAppStore.setState({ workbenchCollapsed: false });
    const expanded = render(<TitleBar />);
    const collapseParent = expanded.getByTestId('titlebar-collapse-workbench').parentElement;
    cleanup();

    useAppStore.setState({ workbenchCollapsed: true });
    const collapsed = render(<TitleBar />);
    const expandParent = collapsed.getByTestId('titlebar-expand-workbench').parentElement;

    // 同一个容器 className ⇒ 同一条 h-12 顶栏里的同一组，纵向位置不会因状态而变。
    expect(collapseParent?.className).toBe(expandParent?.className);
  });
});
