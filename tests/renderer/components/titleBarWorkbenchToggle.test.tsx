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
  // 2026-07-27 审美关拍板：右栏「只在需要时出现」——没有任何视图时不占位。
  // 于是顶栏那颗按钮的语义从「翻收起位」变成「开一个视图（概览）」，
  // 出现条件也从「已收起」变成「已收起 或 一个视图都没有」。
  it('右栏已在显示（有视图且未收起）时，顶栏不画任何右栏按钮', () => {
    useAppStore.setState({ workbenchCollapsed: false, workbenchTabs: ['overview'], activeWorkbenchTab: 'overview' });
    render(<TitleBar />);
    expect(screen.queryByLabelText(en.workbenchTabs.collapsePanel)).toBeNull();
    expect(screen.queryByLabelText(en.workbenchTabs.expandPanel)).toBeNull();
  });

  it('一个视图都没有时留「展开」入口，点击开概览视图', () => {
    // 默认新会话就是这一档：未收起但没有视图 → 右栏不占位，入口仍要有
    render(<TitleBar />);
    fireEvent.click(screen.getByLabelText(en.workbenchTabs.expandPanel));
    expect(useAppStore.getState().workbenchTabs).toEqual(['overview']);
    expect(useAppStore.getState().activeWorkbenchTab).toBe('overview');
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
  });

  it('用户显式收起后点展开：收起位一并清掉，否则按钮点了没反应', () => {
    useAppStore.setState({ workbenchCollapsed: true, workbenchTabs: ['files'], activeWorkbenchTab: 'files' });
    render(<TitleBar />);
    fireEvent.click(screen.getByLabelText(en.workbenchTabs.expandPanel));
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    expect(useAppStore.getState().activeWorkbenchTab).toBe('overview');
  });

  it('二级页在位时不画右栏入口（右栏在二级页里没有对象）', () => {
    render(<TitleBar secondaryPageActive />);
    expect(screen.queryByLabelText(en.workbenchTabs.expandPanel)).toBeNull();
  });
});
