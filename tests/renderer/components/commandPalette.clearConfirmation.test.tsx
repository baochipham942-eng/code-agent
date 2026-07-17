// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const appActions = vi.hoisted(() => ({
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowDAGPanel: vi.fn(),
  setShowWorkspace: vi.fn(),
  setSidebarCollapsed: vi.fn(),
}));
const sessionActions = vi.hoisted(() => ({
  createSession: vi.fn(),
  clearCurrentSession: vi.fn(),
  archiveSession: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    ...appActions,
    showDAGPanel: false,
    showWorkspace: false,
    sidebarCollapsed: false,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({
    ...sessionActions,
    currentSessionId: 'session-1',
  }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({ keybindings: {}, platform: 'mac' }),
}));
vi.mock('@shared/keybindings', () => ({
  formatShortcutForDisplay: vi.fn(),
  getKeybindingAccelerator: vi.fn(() => undefined),
}));

import { CommandPalette } from '../../../src/renderer/components/CommandPalette';

beforeEach(() => {
  Object.values(appActions).forEach((mock) => mock.mockReset());
  Object.values(sessionActions).forEach((mock) => mock.mockReset());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('CommandPalette clear-chat confirmation', () => {
  it('keeps the palette open behind confirmation and returns to it on mouse cancellation', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /清空对话/ }));

    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '清空当前对话？' })).toBeTruthy();
    expect(sessionActions.clearCurrentSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: '清空当前对话？' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy();
    expect(sessionActions.clearCurrentSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears and closes only after confirming a clear-chat command selected with Enter', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    const input = screen.getByPlaceholderText('搜索命令…');

    fireEvent.change(input, { target: { value: '清空' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '清空当前对话？' })).toBeTruthy();
    expect(sessionActions.clearCurrentSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '清空对话' }));

    expect(sessionActions.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps other commands immediate', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));

    expect(screen.queryByRole('dialog', { name: '清空当前对话？' })).toBeNull();
    expect(sessionActions.createSession).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
