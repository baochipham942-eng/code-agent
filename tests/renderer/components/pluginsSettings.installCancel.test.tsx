// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({
    user: { isAdmin: true },
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';

describe('PluginsSettings install cancellation', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => cleanup());

  it('returns installing → cancelling → idle on a narrow slow install without an error notice', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    let finishInstall!: (value: { success: false; cancelled: true }) => void;
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS) {
        return Promise.resolve({
          success: true,
          data: [{
            name: 'slow-plugin',
            marketplace: 'official',
            source: './slow-plugin',
            skills: ['slow'],
          }],
        });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN) {
        return new Promise((resolve) => {
          finishInstall = resolve;
        });
      }
      if (channel === IPC_CHANNELS.MARKETPLACE_CANCEL_INSTALL) {
        return Promise.resolve({ success: true, data: { cancelled: true } });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    const install = await screen.findByRole('button', {
      name: zh.settings.plugins.marketplace.install,
    });
    fireEvent.click(install);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN,
        'slow-plugin@official',
        { scope: 'user' },
      );
      expect(screen.getByTestId('plugin-install-state-slow-plugin@official').getAttribute('data-state'))
        .toBe('installing');
    });
    expect(screen.getByText(zh.settings.plugins.marketplace.installing)).toBeTruthy();
    fireEvent.click(screen.getByText(zh.settings.plugins.marketplace.cancelInstall));
    expect(screen.getByText(zh.settings.plugins.marketplace.cancelling)).toBeTruthy();

    finishInstall({ success: false, cancelled: true });
    await waitFor(() => expect(screen.getByText(zh.settings.plugins.marketplace.install)).toBeTruthy());
    expect(document.body.textContent).not.toContain(zh.settings.plugins.errors.operationFailed);
  });
});
