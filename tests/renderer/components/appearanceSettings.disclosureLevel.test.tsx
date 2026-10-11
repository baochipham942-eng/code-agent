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

const levels = zhSettingsCore.appearance.disclosureLevels;

describe('AppearanceSettings disclosure level', () => {
  beforeEach(() => {
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
    useAppStore.setState({ disclosureLevel: 'standard', developerMode: false, language: 'zh' });
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => (
      action === 'get' ? { ui: { fontSize: 14 } } : undefined
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('updates the store immediately and persists ui.disclosureLevel', async () => {
    let releaseSave: () => void = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      await saveGate;
      return undefined;
    });

    render(<AppearanceSettings />);
    expect(screen.getAllByRole('radio')).toHaveLength(4);

    fireEvent.click(screen.getByRole('radio', { name: levels.simple }));

    expect(useAppStore.getState().disclosureLevel).toBe('simple');
    expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
      ui: { disclosureLevel: 'simple' },
    });
    releaseSave();
    await saveGate;
  });

  it('restores the previous level and shows an error toast when save fails', async () => {
    useAppStore.setState({ disclosureLevel: 'advanced' });
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'get') return { ui: { fontSize: 14 } };
      throw new Error('offline');
    });

    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('radio', { name: levels.expert }));

    await waitFor(() => expect(useAppStore.getState().disclosureLevel).toBe('advanced'));
    expect(screen.getByRole('radio', { name: levels.advanced }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: levels.expert }).getAttribute('aria-checked')).toBe('false');
    expect(toastError).toHaveBeenCalledWith(zhSettingsCore.appearance.disclosureLevelSaveFailed);
  });
});
