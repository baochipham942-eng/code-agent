// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type {
  SurfaceLiveFrameStreamInput,
  SurfaceLiveFrameStreamState,
} from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const runRepairAction = vi.fn(async () => undefined);

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;
let lastLiveFrameInput: SurfaceLiveFrameStreamInput | null = null;

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: (input: SurfaceLiveFrameStreamInput) => {
    lastLiveFrameInput = input;
    return liveFrameState;
  },
}));

const FRAME_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

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
    browserSurfaceSessionId: null,
    browserSurfaceTitle: null,
    browserSurfaceOrigin: null,
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction,
    ...overrides,
  } as BrowserSessionState;
}

describe('BrowserAgentWindow（B1-R·R1 图形化现场）', () => {
  beforeEach(() => {
    runRepairAction.mockClear();
    lastLiveFrameInput = null;
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      localOpsTab: 'desktop',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
    });
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('无流空态：居中一句话提示 + 一个主按钮，不摆状态卡片堆', () => {
    browserSessionState = buildBrowserSessionState({
      blocked: true,
      blockedDetail: '托管浏览器还没启动',
      repairActions: [
        { kind: 'launch_managed_browser', label: '启动 Headless' },
        { kind: 'launch_managed_browser_visible', label: '启动 Visible' },
      ],
    });
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-empty')).toBeTruthy();
    expect(screen.getByText('浏览器还没准备好')).toBeTruthy();
    expect(screen.getByText('托管浏览器还没启动')).toBeTruthy();
    // 拆掉的卡片堆：状态条 / 指针时间线 / 常驻修复卡都不该再存在
    expect(screen.queryByTestId('browser-agent-window-status')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-repair')).toBeNull();
    expect(screen.queryByText('操作记录')).toBeNull();

    fireEvent.click(screen.getByTestId('browser-agent-window-repair-launch_managed_browser'));
    expect(runRepairAction).toHaveBeenCalledWith({
      kind: 'launch_managed_browser',
      label: '启动 Headless',
    });
  });

  it('有帧：全幅渲染页面画面 + 指针叠加，chrome 条给状态点/标题/URL', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 3,
        activeTab: { id: 'tab-1', title: 'Example Domain', url: 'https://example.com/' },
      },
      preview: { mode: 'managed', title: 'Example Domain', url: 'https://example.com/' },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Example Domain',
      browserSurfaceOrigin: 'https://example.com',
    });
    liveFrameState = {
      frame: {
        version: 1,
        conversationId: 'session-a',
        surfaceSessionId: 'surface-1',
        mimeType: 'image/jpeg',
        dataUrl: FRAME_DATA_URL,
        width: 960,
        height: 600,
        capturedAtMs: 1,
      },
      streaming: true,
      unavailableReason: null,
    };
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

    const frame = screen.getByTestId('browser-agent-window-frame') as HTMLImageElement;
    expect(frame.getAttribute('src')).toBe(FRAME_DATA_URL);
    expect(frame.className).toContain('object-contain');
    expect(screen.queryByTestId('browser-agent-window-empty')).toBeNull();

    const chrome = screen.getByTestId('browser-agent-window-chrome');
    expect(chrome.textContent).toContain('Example Domain');
    expect(chrome.textContent).toContain('https://example.com/');
    expect(screen.getByTestId('browser-agent-window-status-dot').getAttribute('title')).toBe('运行中');
    // 指针叠加画在画面上
    expect(screen.getByLabelText(/Search/)).toBeTruthy();
  });

  it('右上菜单的高级设置外链图标使用紧凑尺寸，不压住文字', () => {
    render(<BrowserAgentWindow />);

    fireEvent.click(screen.getByTestId('browser-agent-window-more'));

    const icon = screen
      .getByTestId('browser-agent-window-open-local-ops')
      .querySelector('svg');
    expect(icon?.classList.contains('h-3.5')).toBe(true);
    expect(icon?.classList.contains('w-3.5')).toBe(true);
  });

  it('chrome 条描述画面里那扇窗：managedSession 说「未启动」也不许把状态点跳灰', () => {
    // managedSession 是 IPC 的全局默认单例，跟 agent 实际驱动的 surface 浏览器不是
    // 同一个；5s 轮询会把它刷回 running=false，chrome 条不能跟着跳。
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: false, tabCount: 0, activeTab: null },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Wikipedia',
      browserSurfaceOrigin: 'https://wikipedia.org',
    });
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-status-dot').getAttribute('title')).toBe('运行中');
    const chrome = screen.getByTestId('browser-agent-window-chrome');
    expect(chrome.textContent).toContain('Wikipedia');
    expect(chrome.textContent).toContain('https://wikipedia.org');
  });

  it('managedSession 的 URL 与画面那扇窗不同源时只显示 origin，不显示另一扇窗的地址', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: '另一扇窗', url: 'https://other.example/secret' },
      },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Wikipedia',
      browserSurfaceOrigin: 'https://wikipedia.org',
    });
    render(<BrowserAgentWindow />);

    const chrome = screen.getByTestId('browser-agent-window-chrome');
    expect(chrome.textContent).toContain('https://wikipedia.org');
    expect(chrome.textContent).not.toContain('other.example');
    expect(chrome.textContent).not.toContain('另一扇窗');
  });

  it('tab 不可见（右栏收起）时把 visible 传 false —— 节流护栏不许后台开流', () => {
    useAppStore.setState({ workbenchCollapsed: true });
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      browserSurfaceSessionId: 'surface-1',
    });
    render(<BrowserAgentWindow />);

    expect(lastLiveFrameInput).toMatchObject({ surfaceSessionId: 'surface-1', visible: false });
  });

  it('切到别的 workbench tab 时同样把 visible 传 false', () => {
    useAppStore.setState({ activeWorkbenchTab: 'files' });
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      browserSurfaceSessionId: 'surface-1',
    });
    render(<BrowserAgentWindow />);

    expect(lastLiveFrameInput).toMatchObject({ visible: false });
  });

  it('可见 + 有 surface 会话时才请求开流', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      browserSurfaceSessionId: 'surface-1',
    });
    render(<BrowserAgentWindow />);

    expect(lastLiveFrameInput).toMatchObject({
      surfaceSessionId: 'surface-1',
      visible: true,
      sessionRunning: true,
    });
  });

  it('开不了流时落降级文案，指针仍然跟随', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      browserSurfaceSessionId: 'surface-1',
    });
    liveFrameState = { frame: null, streaming: false, unavailableReason: 'no_active_page' };
    pointerState = {
      event: {
        id: 'pointer-1',
        surface: 'browser',
        tone: 'browser',
        phase: 'move',
        targetLabel: 'Nav',
        point: { x: 10, y: 10, unit: 'percent' },
      },
      lastEvent: null,
      isLive: true,
      timeline: [],
    } as unknown as LiveAgentPointerState;
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-empty').textContent).toContain('暂时接不到实时画面');
    expect(screen.getByLabelText(/Nav/)).toBeTruthy();
  });

  it('非归属会话：chrome 条给只读归属标注，且不给修复动作按钮', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: { running: true, tabCount: 1, activeTab: null },
      ownedByCurrentSession: false,
      blocked: true,
      repairActions: [{ kind: 'launch_managed_browser', label: '启动 Headless' }],
    });
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-foreign')).toBeTruthy();
    expect(screen.queryByTestId('browser-agent-window-repair-launch_managed_browser')).toBeNull();
  });

  it('高级设置收进 ⋯ 溢出菜单，深链到 LocalOps 浏览器 tab', () => {
    render(<BrowserAgentWindow />);
    // 未展开菜单时深链入口不在 DOM 里 —— chrome 条上不该常驻管理按钮
    expect(screen.queryByTestId('browser-agent-window-open-local-ops')).toBeNull();

    fireEvent.click(screen.getByTestId('browser-agent-window-more'));
    fireEvent.click(screen.getByTestId('browser-agent-window-open-local-ops'));

    expect(useAppStore.getState()).toMatchObject({
      showLocalOpsPanel: true,
      localOpsTab: 'browser',
    });
  });
});
