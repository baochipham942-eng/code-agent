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

describe('PrivacySettings app grants', () => {
  afterEach(() => {
    cleanup();
    invokeDomain.mockReset();
  });

  it('renders a granted app and revoke calls the settings action', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const revoked: unknown[] = [];
    invokeDomain.mockImplementation((domain: string, action: string, payload?: unknown) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve({});
      if (domain === IPC_DOMAINS.SETTINGS && action === 'listAppGrants') {
        return Promise.resolve([{ appKey: 'name:notes', name: 'Notes', grantedAt: 1_700_000_000_000 }]);
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'revokeAppGrant') {
        revoked.push(payload);
        return Promise.resolve({ revoked: true });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
        return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
        return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
      }
      throw new Error(`Unexpected call ${domain}:${action}`);
    });

    render(<PrivacySettings />);
    expect(await screen.findByTestId('app-grant-row')).toBeTruthy();
    expect(screen.getByText('Notes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('app-grant-revoke'));
    await waitFor(() => expect(revoked).toEqual([{ appKey: 'name:notes' }]));
    expect(screen.queryByTestId('app-grant-row')).toBeNull();
  });
});
