// ============================================================================
// PrivacySettings 出云密钥掩码开关（N-PROMPT-SECRET-MASK ⑥）
// 默认关；切换只写 privacy.outboundSecretMask（不动同段其他 privacy 键）。
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function mockIpc(settings: Record<string, unknown>): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(settings);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
    if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
      return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
    }
    if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
      return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
    }
    throw new Error(`Unexpected call ${domain}:${action}`);
  });
}

describe('PrivacySettings 出云密钥掩码开关', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('默认关；标题与说明按 i18n 渲染', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    const box = await screen.findByTestId('privacy-outbound-secret-mask-toggle') as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
    expect(screen.getByText(zh.settings.privacy.outboundMask.title)).toBeTruthy();
    expect(screen.getByText(zh.settings.privacy.outboundMask.label)).toBeTruthy();
  });

  it('打开后写 privacy.outboundSecretMask=true，保留同段已有键', async () => {
    mockIpc({ privacy: { postLaunchScoring: 'auto', posthogEnabled: false } });
    render(<PrivacySettings />);

    const box = await screen.findByTestId('privacy-outbound-secret-mask-toggle');
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false));
    fireEvent.click(box);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { privacy: { postLaunchScoring: 'auto', posthogEnabled: false, outboundSecretMask: true } },
      );
    });
    await waitFor(() => expect((screen.getByTestId('privacy-outbound-secret-mask-toggle') as HTMLInputElement).checked).toBe(true));
  });

  it('保存失败时回退到磁盘值（不显示假生效）', async () => {
    mockIpc({});
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve({});
      if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.reject(new Error('disk full'));
      if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
        return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
      }
      if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
        return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
      }
      throw new Error(`Unexpected call ${domain}:${action}`);
    });
    render(<PrivacySettings />);

    const box = await screen.findByTestId('privacy-outbound-secret-mask-toggle');
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false));
    fireEvent.click(box);

    await waitFor(() => expect((screen.getByTestId('privacy-outbound-secret-mask-toggle') as HTMLInputElement).checked).toBe(false));
  });
});
