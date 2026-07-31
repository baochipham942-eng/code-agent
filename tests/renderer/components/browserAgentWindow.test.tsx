// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const runRepairAction = vi.fn(async () => undefined);

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));

function buildBrowserSessionState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: { running: false, tabCount: 0, activeTab: null },
    computerSurface: null,
    preview: null,
    readinessItems: [],
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    actionError: null,
    ownedByCurrentSession: true,
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction,
    ...overrides,
  } as BrowserSessionState;
}

describe('BrowserAgentWindow', () => {
  beforeEach(() => {
    runRepairAction.mockClear();
    useAppStore.setState({ language: 'zh', showLocalOpsPanel: false, localOpsTab: 'desktop' });
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('未就绪：显示未启动状态 + 修复动作按钮，点击走 runRepairAction', () => {
    browserSessionState = buildBrowserSessionState({
      blocked: true,
      blockedDetail: '托管浏览器还没启动',
      repairActions: [{ kind: 'launch_managed_browser', label: '启动 Headless' }],
    });
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-status').textContent).toContain('未启动');
    expect(screen.getByTestId('browser-agent-window-idle')).toBeTruthy();
    expect(screen.getByText('托管浏览器还没启动')).toBeTruthy();

    fireEvent.click(screen.getByTestId('browser-agent-window-repair-launch_managed_browser'));
    expect(runRepairAction).toHaveBeenCalledWith({
      kind: 'launch_managed_browser',
      label: '启动 Headless',
    });
  });

  it('running：状态条给出模式/标签页数/活动页，并渲染实时指针现场', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 3,
        activeTab: { id: 'tab-1', title: 'Example Domain', url: 'https://example.com/' },
      },
      preview: { mode: 'managed', title: 'Example Domain', url: 'https://example.com/' },
    });
    pointerState = {
      event: {
        id: 'pointer-1',
        surface: 'browser',
        tone: 'browser',
        phase: 'click',
        targetLabel: 'Search',
        point: { x: 40, y: 30, unit: 'percent' },
      },
      lastEvent: null,
      isLive: true,
      timeline: [],
    } as unknown as LiveAgentPointerState;
    render(<BrowserAgentWindow />);

    const status = screen.getByTestId('browser-agent-window-status');
    expect(status.textContent).toContain('隔离托管浏览器');
    expect(status.textContent).toContain('运行中');
    expect(status.textContent).toContain('3 个标签页');
    expect(status.textContent).toContain('https://example.com/');
    // 有实时指针事件时不落空态，走 AgentPointerPreviewCard
    expect(screen.queryByTestId('browser-agent-window-idle')).toBeNull();
    expect(screen.getByLabelText(/Search/)).toBeTruthy();
  });

  it('非归属会话：给只读归属标注，且不给修复动作按钮', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      ownedByCurrentSession: false,
      blocked: true,
      repairActions: [{ kind: 'launch_managed_browser', label: '启动 Headless' }],
    });
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-foreign')).toBeTruthy();
    expect(screen.queryByTestId('browser-agent-window-repair')).toBeNull();
  });

  it('高级面板入口深链到 LocalOps 浏览器 tab，不在本页重造管理面板', () => {
    render(<BrowserAgentWindow />);
    fireEvent.click(screen.getByTestId('browser-agent-window-open-local-ops'));

    expect(useAppStore.getState()).toMatchObject({
      showLocalOpsPanel: true,
      localOpsTab: 'browser',
    });
  });
});
