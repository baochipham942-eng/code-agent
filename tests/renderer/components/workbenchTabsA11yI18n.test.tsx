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

  it('does not render shortcut chips for views without an enabled binding', () => {
    render(<WorkbenchTabs />);

    expect(screen.queryByTestId('workbench-shortcut-browser')).toBeNull();
    expect(screen.queryByTestId('workbench-shortcut-design-canvas')).toBeNull();
  });

  it('uses the same launcher component from the new-view button', () => {
    useAppStore.setState({ workbenchTabs: ['overview'], activeWorkbenchTab: 'overview' });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.openPanel));

    expect(screen.getByTestId('workbench-view-launcher-panel')).toBeTruthy();
    expect(screen.queryByTestId('open-workbench-view-overview')).toBeNull();
    expect(screen.getByTestId('open-workbench-view-files')).toBeTruthy();
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

  it('closes the current view and conditionally returns to the full launcher', () => {
    useAppStore.setState({
      workbenchTabs: ['files'],
      activeWorkbenchTab: 'files',
    });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.closeCurrentView));

    expect(useAppStore.getState().workbenchTabs).toEqual([]);
    expect(useAppStore.getState().activeWorkbenchTab).toBeNull();
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

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.closeCurrentView));
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
