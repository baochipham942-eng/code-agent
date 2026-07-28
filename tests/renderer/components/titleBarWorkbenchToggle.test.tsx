// @vitest-environment jsdom
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
import { en } from '../../../src/renderer/i18n/en';

beforeEach(() => {
  useAppStore.setState({ language: 'en', workbenchCollapsed: false, workbenchTabs: [], activeWorkbenchTab: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', workbenchCollapsed: false });
});

describe('TitleBar 右栏开关', () => {
  // 2026-07-27 审美关拍板：右栏「只在需要时出现」= 默认收起（appStore 初值 workbenchCollapsed: true）。
  // 顶栏按钮语义不变（翻收起位）——曾试过改成「没视图就不占位 + 按钮开概览视图」，
  // 但那会把空态启动器里的四个发现入口一并藏掉，e2e 当场抓到可达性回退，已回退该建模。
  // 2026-07-27 推翻 D5「顶栏不叠收起钮、收起 affordance 只在面板头」：
  // 那个建模把一个开关的两态放在两行里，产品负责人实测「展开收起按钮纵向位置会变」；
  // 且面板头那条工具条在空态整条早退，右栏会关不掉。现在顶栏这颗是唯一一颗，不构成重复。
  it('展开态顶栏就是收起入口（同一槽位翻图标），不再依赖面板头', () => {
    useAppStore.setState({ workbenchCollapsed: false });
    render(<TitleBar />);
    expect(screen.getByLabelText(en.workbenchTabs.collapsePanel)).toBeTruthy();
    expect(screen.queryByLabelText(en.workbenchTabs.expandPanel)).toBeNull();
  });

  it('收起态顶栏留「展开」入口，点击展开整栏（不动 workbenchTabs）', () => {
    useAppStore.setState({ workbenchCollapsed: true });
    render(<TitleBar />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.expandPanel));
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    // 展开是整栏开关，不该顺手往 workbenchTabs 里塞 overview。
    expect(useAppStore.getState().workbenchTabs).toEqual([]);
  });

  it('右栏默认收起：新会话不该一上来就占三分之一屏', () => {
    // 这条钉的是 appStore 初值本身——把它改回 false 就红
    expect(useAppStore.getInitialState().workbenchCollapsed).toBe(true);
  });

  it('二级页在位时不画右栏入口（右栏在二级页里没有对象）', () => {
    useAppStore.setState({ workbenchCollapsed: true });
    render(<TitleBar secondaryPageActive />);
    expect(screen.queryByLabelText(en.workbenchTabs.expandPanel)).toBeNull();
  });
});
