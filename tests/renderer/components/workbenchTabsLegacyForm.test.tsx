// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// WorkbenchTabs —— 设计模式会话化收口：保留网页/演示稿/视频入口。
//  旧全屏表单不再随设计模式自动弹出，改为工具条上的次要按钮按需打开：
//  点击「网页/演示稿/视频」按钮 → setDesignFormOpen(true)。
//  仅有 currentSession 时显示（与设计画布入口同条件）。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

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
import { useWorkspaceModeStore } from '../../../src/renderer/stores/workspaceModeStore';

const realSetDesignFormOpen = useWorkspaceModeStore.getState().setDesignFormOpen;

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ workbenchTabs: [], activeWorkbenchTab: null, previewTabs: [], language: 'zh' });
  useSessionStore.setState({ currentSessionId: null });
  useWorkspaceModeStore.setState({ designFormOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({ currentSessionId: null });
  useWorkspaceModeStore.setState({ designFormOpen: false, setDesignFormOpen: realSetDesignFormOpen });
});

describe('WorkbenchTabs 网页/演示稿/视频 入口', () => {
  it('有当前会话时点击 → setDesignFormOpen(true)', () => {
    const setFormOpen = vi.fn();
    useSessionStore.setState({ currentSessionId: 's1' });
    useWorkspaceModeStore.setState({ setDesignFormOpen: setFormOpen });

    const { getByTestId } = render(<WorkbenchTabs />);
    const btn = getByTestId('open-design-legacy-form') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    expect(setFormOpen).toHaveBeenCalledWith(true);
  });

  it('无当前会话时按钮 disabled，点击不触发', () => {
    const setFormOpen = vi.fn();
    useSessionStore.setState({ currentSessionId: null });
    useWorkspaceModeStore.setState({ setDesignFormOpen: setFormOpen });

    const { getByTestId } = render(<WorkbenchTabs />);
    const btn = getByTestId('open-design-legacy-form') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    expect(setFormOpen).not.toHaveBeenCalled();
  });
});
