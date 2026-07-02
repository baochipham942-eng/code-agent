// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AppearanceSettings } from '../../../src/renderer/components/features/settings/tabs/AppearanceSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));

describe('AppearanceSettings developer mode toggle', () => {
  beforeEach(() => {
    // jsdom 不实现 window.matchMedia（useTheme 依赖），需 stub
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })) as never;
    useAppStore.setState({ developerMode: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the developer mode toggle switched off by default', () => {
    const { container } = render(<AppearanceSettings />);
    expect(container.innerHTML).toContain('开发者模式');
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('turns on developer mode and persists it when toggled', () => {
    const { container } = render(<AppearanceSettings />);
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(useAppStore.getState().developerMode).toBe(true);
    expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
      ui: { developerMode: true },
    });
  });

  it('turns developer mode back off when toggled again', () => {
    useAppStore.setState({ developerMode: true });
    const { container } = render(<AppearanceSettings />);
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle!);
    expect(useAppStore.getState().developerMode).toBe(false);
  });
});
