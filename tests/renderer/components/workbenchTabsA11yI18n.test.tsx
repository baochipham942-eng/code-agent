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
  // 要么都有键、要么都没有。视图清单从 DOM 现取，将来加第五个视图漏配默认键同样会红。
  it('gives every launchable view a shortcut chip in the default config', () => {
    render(<WorkbenchTabs />);

    const rows = screen.getAllByTestId(/^open-workbench-view-/);
    expect(rows).toHaveLength(4);
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

  it('one popover serves both switching and adding — an unopened view is reachable from the header', () => {
    useAppStore.setState({ workbenchTabs: ['overview'], activeWorkbenchTab: 'overview' });
    render(<WorkbenchTabs />);

    // 单一入口是本单的要害：分成「选择器」+「加号」两个入口时，用户在「概览 ∨」
    // 里看不到浏览器/文件，就以为切不过去。
    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));

    const menu = screen.getByTestId('workbench-view-menu');
    expect(within(menu).getByRole('option', { name: new RegExp(en.workbenchTabs.overviewLabel) })).toBeTruthy();
    expect(within(menu).getByTestId('workbench-view-launcher-panel')).toBeTruthy();
    expect(within(menu).queryByTestId('open-workbench-view-overview')).toBeNull();

    fireEvent.click(within(menu).getByTestId('open-workbench-view-files'));
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');
    expect(screen.queryByTestId('workbench-view-menu')).toBeNull();
  });
});

describe('WorkbenchTabs single-select switcher', () => {
  it('renders the selector instead of the empty launcher and keeps exactly one active option', () => {
    useAppStore.setState({
      workbenchTabs: ['overview', 'files', 'browser'],
      activeWorkbenchTab: 'overview',
    });
    render(<WorkbenchTabs />);

    expect(screen.queryByTestId('workbench-empty-launcher')).toBeNull();
    expect(screen.getByTestId('workbench-view-selector')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));
    let listbox = screen.getByRole('listbox', { name: en.workbenchTabs.openViews });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    expect(within(listbox).getAllByRole('option').filter(
      (option) => option.getAttribute('aria-selected') === 'true',
    )).toHaveLength(1);

    fireEvent.click(within(listbox).getByRole('option', { name: en.workbenchTabs.filesLabel }));
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));
    listbox = screen.getByRole('listbox', { name: en.workbenchTabs.openViews });
    const activeOptions = within(listbox).getAllByRole('option').filter(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    expect(activeOptions).toHaveLength(1);
    expect(activeOptions[0].textContent).toContain(en.workbenchTabs.filesLabel);
  });

  it('marks selector navigation as user-originated for surface-intent suppression', () => {
    const openWorkbenchTab = vi.fn();
    useAppStore.setState({
      workbenchTabs: ['overview', 'files'],
      activeWorkbenchTab: 'overview',
      openWorkbenchTab,
    });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));
    fireEvent.click(screen.getByRole('option', { name: en.workbenchTabs.filesLabel }));

    expect(openWorkbenchTab).toHaveBeenCalledWith('files', { source: 'user' });
  });

  it('the header close button collapses the whole column instead of closing one view', () => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
      workbenchCollapsed: false,
    });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.collapsePanel));

    // 收起的是整栏；面板本身留着，展开后回到原来那个视图。
    expect(useAppStore.getState().workbenchCollapsed).toBe(true);
    expect(useAppStore.getState().workbenchTabs).toEqual(['files']);
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');
  });

  it('closing a single view lives inside the popover and falls back to the launcher', () => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
    });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));
    fireEvent.click(screen.getByLabelText(
      en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.filesLabel),
    ));

    expect(useAppStore.getState().workbenchTabs).toEqual([]);
    expect(useAppStore.getState().activeWorkbenchTab).toBeNull();
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
    expect(screen.queryByTestId('workbench-view-selector')).toBeNull();
    expect(screen.getByTestId('workbench-empty-launcher')).toBeTruthy();
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

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.chooseView));
    fireEvent.click(screen.getByLabelText(
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
