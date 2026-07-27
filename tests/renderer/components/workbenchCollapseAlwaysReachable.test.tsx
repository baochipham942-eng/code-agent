// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// 右栏「收起」是唯一出口，必须在**每一档**都在场。
//
// 2026-07-27 产品负责人截图：一个 view 都没开时 WorkbenchTabs 走 metas.length === 0 早退，
// 整条工具条不画 ⇒ 收起按钮随之消失，右栏关不掉（顶栏那颗只在已收起时画，是展开用的）。
// 这条门钉的是行为而不是某个 className：空态与有 tab 态都必须拿得到收起按钮且点得动。
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

const realSetWorkbenchCollapsed = useAppStore.getState().setWorkbenchCollapsed;

beforeEach(() => {
  useAppStore.setState({ workbenchTabs: [], activeWorkbenchTab: null, previewTabs: [], language: 'zh' });
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ setWorkbenchCollapsed: realSetWorkbenchCollapsed });
  useSessionStore.setState({ currentSessionId: null });
});

describe('右栏收起入口', () => {
  it('一个 view 都没开（空态）时收起按钮仍在，且点击能收起', () => {
    const collapseFn = vi.fn();
    useAppStore.setState({ setWorkbenchCollapsed: collapseFn });

    const { getByTestId } = render(<WorkbenchTabs />);
    fireEvent.click(getByTestId('workbench-collapse-panel'));

    expect(collapseFn).toHaveBeenCalledWith(true);
  });

  it('已开 view 时收起按钮同样在场', () => {
    const collapseFn = vi.fn();
    useAppStore.setState({ workbenchTabs: ['overview'], activeWorkbenchTab: 'overview', setWorkbenchCollapsed: collapseFn });

    const { getByTestId } = render(<WorkbenchTabs />);
    fireEvent.click(getByTestId('workbench-collapse-panel'));

    expect(collapseFn).toHaveBeenCalledWith(true);
  });
});
