// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

afterEach(() => cleanup());

describe('PrivacySettings third-party interface plugin switch', () => {
  it('is visible, starts off, and persists an explicit user opt-in', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    invokeDomain.mockImplementation((domain: string, action: string, payload?: unknown) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({ pluginUi: { thirdPartyEnabled: false } });
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
      if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
        return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
        return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
      }
      throw new Error(`Unexpected call ${domain}:${action}:${JSON.stringify(payload)}`);
    });

    render(<PrivacySettings />);
    const checkbox = await screen.findByRole('checkbox', { name: /允许第三方插件显示界面/ });
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
    expect(screen.getByText(zh.settings.privacy.pluginUi.body)).toBeTruthy();

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { pluginUi: { thirdPartyEnabled: true } },
      );
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
});
