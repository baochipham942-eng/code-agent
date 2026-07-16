// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppearanceSettings } from '../../../src/renderer/components/features/settings/tabs/AppearanceSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { zhSettingsCore } from '../../../src/renderer/i18n/zhSettingsCore';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
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
    localStorage.setItem('code-agent-theme', 'dark');
    document.documentElement.style.setProperty('--font-size-base', '14px');
    useAppStore.setState({ developerMode: false, language: 'zh' });
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) =>
      action === 'get' ? { ui: { fontSize: 14 } } : undefined,
    );
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

  it('主题保存失败时回滚主题并提示错误', async () => {
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      throw new Error('offline');
    });
    render(<AppearanceSettings />);

    fireEvent.click(screen.getByText('浅色').closest('button')!);

    await waitFor(() => expect(localStorage.getItem('code-agent-theme')).toBe('dark'));
    expect(toastError).toHaveBeenCalledWith(zhSettingsCore.appearance.themeSaveFailed);
  });

  it('语言保存失败时回滚语言并提示错误', async () => {
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      throw new Error('offline');
    });
    render(<AppearanceSettings />);

    fireEvent.click(screen.getByText('English').closest('button')!);

    await waitFor(() => expect(useAppStore.getState().language).toBe('zh'));
    expect(toastError).toHaveBeenCalledWith(zhSettingsCore.appearance.languageSaveFailed);
  });

  it('开发者模式保存失败时回滚开关并提示错误', async () => {
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      throw new Error('offline');
    });
    const { container } = render(<AppearanceSettings />);

    fireEvent.click(container.querySelector('[role="switch"]')!);

    await waitFor(() => expect(useAppStore.getState().developerMode).toBe(false));
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(toastError).toHaveBeenCalledWith(zhSettingsCore.appearance.developerModeSaveFailed);
  });

  it('字体大小保存失败时回滚选项和 CSS 变量并提示错误', async () => {
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      throw new Error('offline');
    });
    render(<AppearanceSettings />);

    fireEvent.click(screen.getByText('大').closest('button')!);

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--font-size-base')).toBe('14px');
    });
    expect(screen.getByText('中', { selector: 'span' }).closest('button')?.className).toContain('bg-zinc-800/60');
    expect(toastError).toHaveBeenCalledWith(zhSettingsCore.appearance.fontSizeSaveFailed);
  });
});
