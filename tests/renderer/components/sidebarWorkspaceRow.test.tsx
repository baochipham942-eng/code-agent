// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SidebarWorkspaceRow } from '../../../src/renderer/components/features/sidebar/SidebarWorkspaceRow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { zh } from '../../../src/renderer/i18n/zh';

beforeEach(() => {
  useAppStore.setState({ language: 'zh', workingDirectory: null });
  useComposerStore.setState({ workingDirectory: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', workingDirectory: null });
  useComposerStore.setState({ workingDirectory: null });
});

describe('SidebarWorkspaceRow（顶栏目录 chip 退役后的目录入口）', () => {
  it('未设置目录时显示「选择目录」引导态', () => {
    render(<SidebarWorkspaceRow />);
    const row = screen.getByTestId('sidebar-workspace-row');
    expect(row.textContent).toContain(zh.sidebar.selectDirectory);
    expect(row.getAttribute('aria-label')).toBe(`${zh.sidebar.currentDirectory}: ${zh.sidebar.selectDirectory}`);
  });

  it('已设置目录时显示目录名，title 挂完整路径', () => {
    useComposerStore.setState({ workingDirectory: '/Users/demo/project-neo' });
    render(<SidebarWorkspaceRow />);
    const row = screen.getByTestId('sidebar-workspace-row');
    expect(row.textContent).toContain('project-neo');
    expect(row.getAttribute('title')).toBe('/Users/demo/project-neo');
  });

  it('composer 目录优先于全局 appStore 目录（沿用原 TitleBar 判定）', () => {
    useAppStore.setState({ workingDirectory: '/global/app' });
    useComposerStore.setState({ workingDirectory: '/composer/wins' });
    render(<SidebarWorkspaceRow />);
    expect(screen.getByTestId('sidebar-workspace-row').textContent).toContain('wins');
  });

  it('非桌面模式点击弹出路径输入框，确认后写 composer+app 两条 store（同原 chip 通道）', async () => {
    render(<SidebarWorkspaceRow />);
    fireEvent.click(screen.getByTestId('sidebar-workspace-row'));

    const input = await screen.findByPlaceholderText(zh.sidebar.pathDialogPlaceholder);
    fireEvent.change(input, { target: { value: '/typed/path' } });
    fireEvent.click(screen.getByRole('button', { name: zh.sidebar.confirm }));

    expect(useComposerStore.getState().workingDirectory).toBe('/typed/path');
    expect(useAppStore.getState().workingDirectory).toBe('/typed/path');
  });
});
