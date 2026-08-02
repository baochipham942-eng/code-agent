// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  createDefaultKeybindingsSettings,
  formatShortcutForDisplay,
  KEYBINDING_DEFINITIONS,
  type KeybindingsSettings,
} from '../../../src/shared/keybindings';

const keybindingsRuntime = vi.hoisted(() => ({
  keybindings: null as KeybindingsSettings | null,
  platform: 'darwin' as const,
}));

vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({
    keybindings: keybindingsRuntime.keybindings,
    platform: keybindingsRuntime.platform,
  }),
}));

import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const realOpenWorkbenchTab = useAppStore.getState().openWorkbenchTab;

beforeEach(() => {
  vi.restoreAllMocks();
  keybindingsRuntime.keybindings = createDefaultKeybindingsSettings('darwin');
  useAppStore.setState({
    workbenchTabs: [],
    activeWorkbenchTab: null,
    workbenchCollapsed: false,
    previewTabs: [],
    language: 'en',
    openWorkbenchTab: realOpenWorkbenchTab,
  });
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ language: 'zh', openWorkbenchTab: realOpenWorkbenchTab });
  useSessionStore.setState({ currentSessionId: null });
});

describe('WorkbenchTabs empty-state launcher', () => {
  it('conditionally renders the full launcher and opens a selected view', () => {
    render(<WorkbenchTabs />);

    expect(screen.getByTestId('workbench-empty-launcher')).toBeTruthy();
    expect(screen.queryByTestId('workbench-view-selector')).toBeNull();
    expect(screen.getByTestId('open-workbench-view-overview')).toBeTruthy();
    expect(screen.getByTestId('open-workbench-view-files')).toBeTruthy();
    expect(screen.getByTestId('open-workbench-view-browser')).toBeTruthy();
    expect(screen.getByTestId('open-workbench-view-design-canvas')).toBeTruthy();
    expect(screen.getByTestId('open-workbench-view-terminal')).toBeTruthy();

    fireEvent.click(screen.getByTestId('open-workbench-view-overview'));

    expect(useAppStore.getState().activeWorkbenchTab).toBe('overview');
    expect(screen.queryByTestId('workbench-empty-launcher')).toBeNull();
    expect(screen.getByTestId('workbench-view-selector')).toBeTruthy();
  });

  // 第 10 条：光给「设计画布」这个名字没人知道是什么，「打开一个视图」也是内部词。
  // 每项配一句它给你看什么，中英同步。
  it('每个视图都带一句说明它给你看什么', () => {
    render(<WorkbenchTabs />);

    const launcher = screen.getByTestId('workbench-empty-launcher');
    expect(launcher.textContent).toContain(en.workbenchTabs.emptyTitle);
    for (const description of Object.values(en.workbenchTabs.viewDescriptions)) {
      expect(launcher.textContent).toContain(description);
    }
    // 说明必须真的是人话，不是把标签重复一遍
    expect(en.workbenchTabs.viewDescriptions.designCanvas)
      .not.toBe(zh.design.canvasTabLabel);
  });

  it('中文侧同样带说明，且不残留「打开一个视图」这种内部词', () => {
    useAppStore.setState({ language: 'zh' });
    render(<WorkbenchTabs />);

    const launcher = screen.getByTestId('workbench-empty-launcher');
    for (const description of Object.values(zh.workbenchTabs.viewDescriptions)) {
      expect(launcher.textContent).toContain(description);
    }
    expect(launcher.textContent).not.toContain('打开一个视图');
  });

  it('derives the displayed shortcut from the keybinding registry', () => {
    const definition = KEYBINDING_DEFINITIONS.find(({ id }) => id === 'statusRail.toggle');
    if (!definition) throw new Error('statusRail.toggle definition missing');
    const mutableHotkeys = definition.defaultHotkeys as {
      darwin: string | null;
      win32: string | null;
      linux: string | null;
    };
    const original = mutableHotkeys.darwin;
    mutableHotkeys.darwin = 'Cmd+Shift+9';
    keybindingsRuntime.keybindings = createDefaultKeybindingsSettings('darwin');

    try {
      render(<WorkbenchTabs />);
      expect(screen.getByTestId('workbench-shortcut-overview').textContent).toBe(
        formatShortcutForDisplay(mutableHotkeys.darwin, 'darwin'),
      );
    } finally {
      mutableHotkeys.darwin = original;
    }
  });

  // 这条替换了旧断言「does not render shortcut chips for views without an enabled binding」。
  // 旧断言把「只有概览有键、浏览器/文件/设计画布静默无键」钉成了正确行为，正是 UI 债第 22 条
  // 说的不一致；产品负责人推翻了「加功能不还债」的原判定，判据改成：默认配置下四个视图
  // 要么都有键、要么都没有。视图清单从 DOM 现取，将来加第六个视图漏配默认键同样会红。
  it('gives every launchable view a shortcut chip in the default config', () => {
    render(<WorkbenchTabs />);

    const rows = screen.getAllByTestId(/^open-workbench-view-/);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const viewId = (row.getAttribute('data-testid') ?? '').replace('open-workbench-view-', '');
      expect(screen.getByTestId(`workbench-shortcut-${viewId}`).textContent).toBeTruthy();
    }
  });

  it('reads the files row from the open-files action, not the attachment picker', () => {
    // files.attach 是输入框的附件选择器（scope: 'composer'），本身留着别删；文件视图那行
    // 曾经错挂在它上面。给两者配不同的键，指回 files.attach 就会红。
    const settings = createDefaultKeybindingsSettings('darwin');
    settings.bindings['files.attach'] = { enabled: true, accelerator: 'Cmd+Shift+7' };
    keybindingsRuntime.keybindings = settings;

    render(<WorkbenchTabs />);

    const chip = screen.getByTestId('workbench-shortcut-files').textContent;
    expect(chip).toBe(
      formatShortcutForDisplay(settings.bindings['files.open']?.accelerator ?? null, 'darwin'),
    );
    expect(chip).not.toBe(formatShortcutForDisplay('Cmd+Shift+7', 'darwin'));
  });
});

// D6（2026-07-26 打磨批 D，产品负责人拍板）：下拉切换器改 tab 条形态，
// 对齐 FileExplorerPanel TabBar——已开视图平铺为 tab（当前高亮、hover 显 ×），
// 「＋」弹出可打开视图列表。
describe('WorkbenchTabs tab 条形态（D6）', () => {
  it('已开视图平铺为 role=tab，恰好一个 aria-selected', () => {
    useAppStore.setState({
      workbenchTabs: ['overview', 'files', 'browser'],
      activeWorkbenchTab: 'overview',
    });
    render(<WorkbenchTabs />);

    expect(screen.queryByTestId('workbench-empty-launcher')).toBeNull();
    const tablist = screen.getByRole('tablist', { name: en.workbenchTabs.openViews });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('点击 tab 直接切换（source: user），选中态跟随', () => {
    const openWorkbenchTab = vi.fn();
    useAppStore.setState({
      workbenchTabs: ['overview', 'files'],
      activeWorkbenchTab: 'overview',
      openWorkbenchTab,
    });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByTestId('workbench-tab-files'));
    expect(openWorkbenchTab).toHaveBeenCalledWith('files', { source: 'user' });
  });

  it('「＋」弹出可打开视图列表：不含已开视图，点开即加并收起弹层', () => {
    useAppStore.setState({ workbenchTabs: ['overview'], activeWorkbenchTab: 'overview' });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.addView));
    const menu = screen.getByTestId('workbench-view-menu');
    expect(within(menu).getByTestId('workbench-view-launcher-panel')).toBeTruthy();
    expect(within(menu).queryByTestId('open-workbench-view-overview')).toBeNull();

    fireEvent.click(within(menu).getByTestId('open-workbench-view-files'));
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');
    expect(screen.queryByTestId('workbench-view-menu')).toBeNull();
  });

  it('全部视图都打开后不再渲染「＋」', () => {
    useAppStore.setState({
      workbenchTabs: ['overview', 'files', 'browser', 'design-canvas', 'terminal'],
      activeWorkbenchTab: 'overview',
    });
    render(<WorkbenchTabs />);
    expect(screen.queryByLabelText(en.workbenchTabs.addView)).toBeNull();
  });

  // 2026-07-27：收起整栏的入口已从面板头搬到顶栏（两态同槽，位置不再随开合上下跳），
  // 「收整栏而不是关单视图」这条语义随之由 workbenchCollapseAlwaysReachable.test.tsx 守。
  // 这里改守反向约束：面板头**不该**再长出收起钮，否则同一开关又分居两行、位移问题复发。
  it('面板头不再自带收起钮（收起入口只在顶栏，避免开关两态分居两行）', () => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
      workbenchCollapsed: false,
    });
    render(<WorkbenchTabs />);

    expect(screen.queryByLabelText(en.workbenchTabs.collapsePanel)).toBeNull();
    // tab 上的 × 仍在，两者别混为一谈（下一条用例守它关的是单个视图）。
    expect(screen.getByLabelText(en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.filesLabel))).toBeTruthy();
  });

  it('tab 上的 × 关闭单个视图（含概览/文件等常驻视图），关完回空态启动器', () => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
    });
    render(<WorkbenchTabs />);

    const tab = screen.getByTestId('workbench-tab-files');
    fireEvent.click(within(tab).getByLabelText(
      en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.filesLabel),
    ));

    expect(useAppStore.getState().workbenchTabs).toEqual([]);
    expect(useAppStore.getState().activeWorkbenchTab).toBeNull();
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    expect(screen.queryByTestId('workbench-view-selector')).toBeNull();
    expect(screen.getByTestId('workbench-empty-launcher')).toBeTruthy();
  });

  it('hover 显 ×：关闭按钮默认 opacity-0、group-hover 现身（粘滞同 D3 判据）', () => {
    useAppStore.setState({ workbenchTabs: ['files'], activeWorkbenchTab: 'files' });
    render(<WorkbenchTabs />);

    const tab = screen.getByTestId('workbench-tab-files');
    const closeButton = within(tab).getByLabelText(
      en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.filesLabel),
    );
    expect(closeButton.className).toContain('opacity-0');
    expect(closeButton.className).toContain('group-hover:opacity-100');
    expect(closeButton.className).not.toContain('group-focus-within');
  });
});

describe('WorkbenchTabs compatibility behavior', () => {
  const dirtyPreview = {
    id: 'preview-1',
    path: '/tmp/example.ts',
    content: 'changed',
    savedContent: 'saved',
    mode: 'edit' as const,
    lastActivatedAt: 1,
    isLoaded: true,
  };

  it('keeps dirty-preview confirmation when closing the selected view', () => {
    useAppStore.setState({
      workbenchTabs: ['preview:/tmp/example.ts'],
      activeWorkbenchTab: 'preview:/tmp/example.ts',
      previewTabs: [dirtyPreview],
    });
    render(<WorkbenchTabs />);

    const tab = screen.getByTestId('workbench-tab-preview:/tmp/example.ts');
    fireEvent.click(within(tab).getByLabelText(
      en.workbenchTabs.closeView.replace('{view}', 'example.ts'),
    ));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useAppStore.getState().workbenchTabs).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /不保存/ }));
    expect(useAppStore.getState().workbenchTabs).toEqual([]);
  });

  it('keeps all new shell copy synchronized in Chinese and English', () => {
    const { rerender } = render(<WorkbenchTabs />);
    expect(screen.getByText(en.workbenchTabs.emptyTitle)).toBeTruthy();
    expect(screen.queryByText(zh.workbenchTabs.emptyTitle)).toBeNull();

    useAppStore.setState({ language: 'zh' });
    rerender(<WorkbenchTabs />);
    expect(screen.getByText(zh.workbenchTabs.emptyTitle)).toBeTruthy();
    expect(screen.queryByText(en.workbenchTabs.emptyTitle)).toBeNull();
  });
});
