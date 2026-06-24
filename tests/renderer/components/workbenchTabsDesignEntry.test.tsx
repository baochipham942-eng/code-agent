// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// WorkbenchTabs —— 设计 Surface 会话化改造 Task 4：
//  A) 聊天 workbench bar 里的「设计画布」入口按钮：
//     点击 → markSessionDesignActive(currentSessionId) + openWorkbenchTab('design-canvas')；
//     currentSessionId 为空时按钮 disabled，不触发任何动作。
//  B) design-canvas tab 渲染正式标签（i18n），而非 getFileName fallback。
// 重依赖（preset store / workspace preview / disclosure）mock 掉，聚焦本次行为。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// ---- mock 辅助 hooks/stores，避免 render 拉起重依赖 ----------------------
vi.mock('../../../src/renderer/hooks/useDisclosure', () => ({
  useDisclosure: () => ({ isStandard: true }),
}));
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
}));
vi.mock('../../../src/renderer/stores/workbenchPresetStore', () => {
  const useWorkbenchPresetStore = (selector: (s: { presets: unknown[]; recipes: unknown[] }) => unknown) =>
    selector({ presets: [], recipes: [] });
  return { useWorkbenchPresetStore };
});

import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

// 捕获真实 action，afterEach 还原，避免向同 worker 的其它测试文件泄漏 fake action
const realOpenWorkbenchTab = useAppStore.getState().openWorkbenchTab;
const realMarkSessionDesignActive = useSessionStore.getState().markSessionDesignActive;

beforeEach(() => {
  vi.restoreAllMocks();
  // 复位 appStore workbench tabs / 语言
  useAppStore.setState({ workbenchTabs: [], activeWorkbenchTab: null, previewTabs: [], language: 'zh' });
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 还原真实 action
  useAppStore.setState({ openWorkbenchTab: realOpenWorkbenchTab });
  useSessionStore.setState({ currentSessionId: null, markSessionDesignActive: realMarkSessionDesignActive });
});

describe('WorkbenchTabs 设计画布入口按钮', () => {
  it('有当前会话时点击 → markSessionDesignActive + openWorkbenchTab(design-canvas)', () => {
    const markFn = vi.fn();
    const openFn = vi.fn();
    useSessionStore.setState({ currentSessionId: 's1', markSessionDesignActive: markFn });
    useAppStore.setState({ openWorkbenchTab: openFn });

    const { getByTestId } = render(<WorkbenchTabs />);
    const btn = getByTestId('open-design-canvas') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    expect(markFn).toHaveBeenCalledWith('s1');
    expect(openFn).toHaveBeenCalledWith('design-canvas');
  });

  it('无当前会话时按钮 disabled，点击不触发任何动作', () => {
    const markFn = vi.fn();
    const openFn = vi.fn();
    useSessionStore.setState({ currentSessionId: null, markSessionDesignActive: markFn });
    useAppStore.setState({ openWorkbenchTab: openFn });

    const { getByTestId } = render(<WorkbenchTabs />);
    const btn = getByTestId('open-design-canvas') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);

    expect(markFn).not.toHaveBeenCalled();
    expect(openFn).not.toHaveBeenCalled();
  });
});

describe('WorkbenchTabs design-canvas tab 正式标签', () => {
  it('design-canvas tab 渲染 i18n 正式标签而非文件名 fallback', () => {
    useAppStore.setState({ workbenchTabs: ['design-canvas'], activeWorkbenchTab: 'design-canvas' });
    const { container } = render(<WorkbenchTabs />);
    // 正式标签出现
    expect(container.textContent).toContain('设计画布');
    // 不出现 getFileName('design-canvas') 的 fallback（即原样字符串作为唯一标签）
    // 正式标签恰好也是中文，这里通过断言 tab 元素 title 不为路径来加强
    const tab = container.querySelector('[title="设计画布"], [title*="设计"]');
    expect(tab).toBeTruthy();
  });
});
