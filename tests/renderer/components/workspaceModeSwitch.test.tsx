// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// WorkspaceModeSwitch —— 设计模式会话化收口：
//  切到「设计」+ 有 currentSession → setWorkspaceMode('design')
//    + markSessionDesignActive + claimCanvasForSession + openWorkbenchTab('design-canvas')；
//  切到「设计」但无 currentSession → 只 setWorkspaceMode，不激活会话化画布；
//  切到「通用」(code) → setWorkspaceMode('code') + setDesignFormOpen(false)。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { WorkspaceModeSwitch } from '../../../src/renderer/components/design/WorkspaceModeSwitch';
import { useWorkspaceModeStore } from '../../../src/renderer/stores/workspaceModeStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';

const realSetWorkspaceMode = useWorkspaceModeStore.getState().setWorkspaceMode;
const realSetDesignFormOpen = useWorkspaceModeStore.getState().setDesignFormOpen;
const realMarkSessionDesignActive = useDesignCanvasStore.getState().markSessionDesignActive;
const realOpenWorkbenchTab = useAppStore.getState().openWorkbenchTab;
const realClaimCanvasForSession = useDesignCanvasStore.getState().claimCanvasForSession;

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ language: 'zh' });
  useWorkspaceModeStore.setState({ workspaceMode: 'code', designFormOpen: false });
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useWorkspaceModeStore.setState({
    setWorkspaceMode: realSetWorkspaceMode,
    setDesignFormOpen: realSetDesignFormOpen,
    workspaceMode: 'code',
    designFormOpen: false,
  });
  useSessionStore.setState({ currentSessionId: null });
  useAppStore.setState({ openWorkbenchTab: realOpenWorkbenchTab });
  useDesignCanvasStore.setState({
    claimCanvasForSession: realClaimCanvasForSession,
    markSessionDesignActive: realMarkSessionDesignActive,
  });
});

function clickMode(container: HTMLElement, label: string) {
  const btns = Array.from(container.querySelectorAll('button'));
  const btn = btns.find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`button "${label}" not found`);
  fireEvent.click(btn);
}

describe('WorkspaceModeSwitch 切到设计模式', () => {
  it('有 currentSession：切到设计 → 激活会话化画布 + 开 design-canvas tab', () => {
    const setMode = vi.fn();
    const markFn = vi.fn();
    const claimFn = vi.fn();
    const openFn = vi.fn();
    useWorkspaceModeStore.setState({ setWorkspaceMode: setMode });
    useSessionStore.setState({ currentSessionId: 's1' });
    useDesignCanvasStore.setState({ claimCanvasForSession: claimFn, markSessionDesignActive: markFn });
    useAppStore.setState({ openWorkbenchTab: openFn });

    const { container } = render(<WorkspaceModeSwitch />);
    clickMode(container, '设计');

    expect(setMode).toHaveBeenCalledWith('design');
    expect(markFn).toHaveBeenCalledWith('s1');
    expect(claimFn).toHaveBeenCalledWith('s1');
    expect(openFn).toHaveBeenCalledWith('design-canvas', { source: 'auto' });
  });

  it('无 currentSession：切到设计 → 只 setWorkspaceMode，不激活', () => {
    const setMode = vi.fn();
    const markFn = vi.fn();
    const claimFn = vi.fn();
    const openFn = vi.fn();
    useWorkspaceModeStore.setState({ setWorkspaceMode: setMode });
    useSessionStore.setState({ currentSessionId: null });
    useDesignCanvasStore.setState({ claimCanvasForSession: claimFn, markSessionDesignActive: markFn });
    useAppStore.setState({ openWorkbenchTab: openFn });

    const { container } = render(<WorkspaceModeSwitch />);
    clickMode(container, '设计');

    expect(setMode).toHaveBeenCalledWith('design');
    expect(markFn).not.toHaveBeenCalled();
    expect(claimFn).not.toHaveBeenCalled();
    expect(openFn).not.toHaveBeenCalled();
  });

  it('切到通用(code) → setWorkspaceMode(code) + 关闭表单旗标', () => {
    const setMode = vi.fn();
    const setFormOpen = vi.fn();
    useWorkspaceModeStore.setState({ workspaceMode: 'design', setWorkspaceMode: setMode, setDesignFormOpen: setFormOpen });

    const { container } = render(<WorkspaceModeSwitch />);
    clickMode(container, '通用');

    expect(setMode).toHaveBeenCalledWith('code');
    expect(setFormOpen).toHaveBeenCalledWith(false);
  });
});
