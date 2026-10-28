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

const GRANTS = [
  {
    id: `app-standing:${encodeURIComponent('bundle:com.apple.Notes')}`,
    kind: 'app' as const,
    label: 'Notes',
    detail: 'com.apple.Notes',
    source: 'settings',
    grantedAt: 1_700_000_000_000,
    expiresAt: null,
  },
  {
    id: `standing-grant:${encodeURIComponent('cron:demo')}:${encodeURIComponent('mail_send')}:${encodeURIComponent('team@example.com')}`,
    kind: 'tool-target' as const,
    label: 'mail_send',
    detail: 'team@example.com',
    source: '每周汇总',
    grantedAt: 1_700_000_000_001,
    expiresAt: null,
  },
  {
    id: `tool-session:${encodeURIComponent('conv-2')}:${encodeURIComponent('bash')}`,
    kind: 'tool-session' as const,
    label: 'bash',
    source: 'conversation',
    grantedAt: 1_700_000_000_002,
    expiresAt: null,
  },
];

describe('PrivacySettings permission grants', () => {
  afterEach(() => {
    cleanup();
    invokeDomain.mockReset();
  });

  it('renders the unified list with all three kinds and revoke removes the row', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const revoked: unknown[] = [];
    invokeDomain.mockImplementation((domain: string, action: string, payload?: unknown) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve({});
      if (domain === IPC_DOMAINS.SETTINGS && action === 'listPermissionGrants') {
        return Promise.resolve(GRANTS);
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'revokePermissionGrant') {
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
    expect(await screen.findAllByTestId('permission-grant-row')).toHaveLength(3);
    // 三种条目都呈现：应用名 / 工具+对象 / 会话内工具。
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('mail_send')).toBeTruthy();
    expect(screen.getByText(/team@example.com/)).toBeTruthy();
    expect(screen.getByText('bash')).toBeTruthy();
    // scope 与来源可见（scope 在组合行里，按行内文本断言）。
    const rows = screen.getAllByTestId('permission-grant-row');
    expect(rows.some((row) => row.textContent?.includes(zh.settings.privacy.permissionGrants.scope.always))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes(zh.settings.privacy.permissionGrants.scope.automation.replace('{title}', '每周汇总')))).toBe(true);

    fireEvent.click(screen.getAllByTestId('permission-grant-revoke')[1]);
    await waitFor(() => expect(revoked).toEqual([{ id: GRANTS[1].id }]));
    await waitFor(() => expect(screen.getAllByTestId('permission-grant-row')).toHaveLength(2));
  });

  it('shows the one-sentence empty state when nothing is granted', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve({});
      if (domain === IPC_DOMAINS.SETTINGS && action === 'listPermissionGrants') return Promise.resolve([]);
      if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
        return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
        return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
      }
      throw new Error(`Unexpected call ${domain}:${action}`);
    });

    render(<PrivacySettings />);
    expect(await screen.findByText(zh.settings.privacy.permissionGrants.empty)).toBeTruthy();
    expect(screen.queryByTestId('permission-grant-row')).toBeNull();
  });
});
