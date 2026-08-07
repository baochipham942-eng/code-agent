// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// 专注模式（2026-08-01 工单①）两档切换测试：
//  A) RailTabShell：一个按钮、一个位置、两个状态（侧栏态/专注态只换图标与称谓，
//     testid 不变）；点击切换；Esc 只在专注态退出；不传 onToggleFocus 不画开关
//     （文件/浏览器等其它消费方不受影响）。
//  B) WorkbenchTabs 接线：focusable 时开关驱动 appStore.workbenchFocused 两档往返，
//     Esc 退出；非 focusable（窄屏借住聊天列）不给开关。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';
import React from 'react';

vi.mock('../../../src/renderer/hooks/useDisclosure', () => ({
  useDisclosure: () => ({ isStandard: true }),
}));
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
  // 角色轴（ADR-055）：概览改用 …State 取 { items, materialItems }；替身要跟上新导出
  useWorkspacePreviewModelState: () => ({ items: [], materialItems: [], currentTurnArtifacts: null }),
}));
vi.mock('../../../src/renderer/stores/workbenchPresetStore', () => {
  const useWorkbenchPresetStore = (
    selector: (s: { presets: unknown[]; recipes: unknown[] }) => unknown,
  ) => selector({ presets: [], recipes: [] });
  return { useWorkbenchPresetStore };
});

import { RailTabShell } from '../../../src/renderer/components/composites/RailTabShell';
import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

afterEach(() => {
  cleanup();
});

describe('RailTabShell 专注开关（两档）', () => {
  const tabs = [{ id: 'a', label: '视图A' }];

  it('侧栏态：开关显示「进入」称谓、aria-pressed=false；点击回调一次', () => {
    const onToggleFocus = vi.fn();
    render(
      <RailTabShell
        tabs={tabs}
        activeTabId="a"
        onSelectTab={() => {}}
        ariaLabel="测试"
        focused={false}
        onToggleFocus={onToggleFocus}
        focusEnterLabel="进入专注模式"
        focusExitLabel="退出专注模式"
      />,
    );
    const btn = screen.getByTestId('rail-tab-shell-focus-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('进入专注模式');
    fireEvent.click(btn);
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
  });

  it('专注态：同一位置（testid 不变）只换称谓与按下态；Esc 退出', () => {
    const onToggleFocus = vi.fn();
    render(
      <RailTabShell
        tabs={tabs}
        activeTabId="a"
        onSelectTab={() => {}}
        ariaLabel="测试"
        focused
        onToggleFocus={onToggleFocus}
        focusEnterLabel="进入专注模式"
        focusExitLabel="退出专注模式"
      />,
    );
    const btn = screen.getByTestId('rail-tab-shell-focus-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('退出专注模式');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
  });

  it('侧栏态按 Esc 不触发回调（Esc 只退专注态）', () => {
    const onToggleFocus = vi.fn();
    render(
      <RailTabShell
        tabs={tabs}
        activeTabId="a"
        onSelectTab={() => {}}
        ariaLabel="测试"
        focused={false}
        onToggleFocus={onToggleFocus}
        focusEnterLabel="进入专注模式"
        focusExitLabel="退出专注模式"
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onToggleFocus).not.toHaveBeenCalled();
  });

  it('不传 onToggleFocus → 不画开关（其它消费方零影响）', () => {
    render(
      <RailTabShell tabs={tabs} activeTabId="a" onSelectTab={() => {}} ariaLabel="测试" />,
    );
    expect(screen.queryByTestId('rail-tab-shell-focus-toggle')).toBeNull();
  });
});

describe('WorkbenchTabs 专注模式接线', () => {
  beforeEach(() => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
      previewTabs: [],
      language: 'zh',
    });
    useWorkbenchFocusStore.setState({ workbenchFocused: false });
    useSessionStore.setState({ currentSessionId: 's1' });
  });

  it('focusable：开关驱动 workbenchFocused 两档往返，Esc 退出专注态', () => {
    render(
      <WorkbenchTabs focusable>
        <div>内容</div>
      </WorkbenchTabs>,
    );

    // 侧栏态 → 点击进入专注态
    fireEvent.click(screen.getByTestId('rail-tab-shell-focus-toggle'));
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);

    // 专注态 → 点击退出
    fireEvent.click(screen.getByTestId('rail-tab-shell-focus-toggle'));
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(false);

    // 再进入，Esc 退出
    fireEvent.click(screen.getByTestId('rail-tab-shell-focus-toggle'));
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(false);
  });

  it('非 focusable（窄屏借住聊天列）：不给专注开关', () => {
    render(
      <WorkbenchTabs>
        <div>内容</div>
      </WorkbenchTabs>,
    );
    expect(screen.queryByTestId('rail-tab-shell-focus-toggle')).toBeNull();
  });

  it('最后一个 tab 关掉后专注态自动退回侧栏态（空 launcher 不许占满整窗）', () => {
    useWorkbenchFocusStore.setState({ workbenchFocused: true });
    render(
      <WorkbenchTabs focusable>
        <div>内容</div>
      </WorkbenchTabs>,
    );
    act(() => {
      useAppStore.getState().closeWorkbenchTab('files');
    });
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(false);
  });
});
