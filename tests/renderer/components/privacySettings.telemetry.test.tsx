// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());
const ENV_KEY = '__NEO_TELEMETRY_ENV__';

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

const TOGGLES = [
  'privacy-posthog-toggle',
  'privacy-cloud-upload-toggle',
  'privacy-langfuse-toggle',
  'privacy-crash-reporting-toggle',
] as const;

function setReportedEnv(env: Record<string, string> | undefined): void {
  const host = window as unknown as Record<string, unknown>;
  if (!env) delete host[ENV_KEY];
  else host[ENV_KEY] = env;
}

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

describe('PrivacySettings telemetry channel toggles', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
    setReportedEnv(undefined);
  });

  afterEach(() => {
    cleanup();
    setReportedEnv(undefined);
  });

  it('renders three usage toggles and crash reporting on by default', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    expect(screen.getByText(zh.settings.privacy.telemetry.posthog.label)).toBeTruthy();
    expect(screen.getByText(zh.settings.privacy.telemetry.cloudUpload.label)).toBeTruthy();
    expect(screen.getByText(zh.settings.privacy.telemetry.langfuse.label)).toBeTruthy();
    for (const testId of TOGGLES) {
      const box = await screen.findByTestId(testId);
      await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
      expect((box as HTMLInputElement).disabled).toBe(false);
    }
    expect(screen.queryByTestId('privacy-env-opt-out-reason')).toBeNull();
  });

  it('disables every toggle and shows the reason when DO_NOT_TRACK is reported', async () => {
    setReportedEnv({ DO_NOT_TRACK: '1' });
    mockIpc({
      privacy: {
        posthogEnabled: true,
        cloudUploadEnabled: true,
        langfuseEnabled: true,
        crashReportingEnabled: true,
      },
    });
    render(<PrivacySettings />);

    const reason = await screen.findByTestId('privacy-env-opt-out-reason');
    expect(reason.textContent).toBe(
      zh.settings.privacy.telemetry.envOptOut.replace('{name}', 'DO_NOT_TRACK'),
    );
    for (const testId of TOGGLES) {
      const box = screen.getByTestId(testId) as HTMLInputElement;
      await waitFor(() => expect(box.checked).toBe(false));
      expect(box.disabled).toBe(true);
    }

    fireEvent.click(screen.getByTestId('privacy-cloud-upload-toggle'));
    await waitFor(() => {
      const writes = invokeDomain.mock.calls.filter((call) => call[1] === 'set');
      expect(writes).toEqual([]);
    });
  });

  it('writes only the channel that was toggled', async () => {
    mockIpc({ privacy: { postLaunchScoring: 'auto' } });
    render(<PrivacySettings />);

    const posthog = await screen.findByTestId('privacy-posthog-toggle');
    await waitFor(() => expect((posthog as HTMLInputElement).checked).toBe(true));
    fireEvent.click(posthog);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { privacy: { postLaunchScoring: 'auto', posthogEnabled: false } },
      );
    });
    expect((screen.getByTestId('privacy-cloud-upload-toggle') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('privacy-langfuse-toggle') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('privacy-crash-reporting-toggle') as HTMLInputElement).checked).toBe(true);
    const writes = invokeDomain.mock.calls.filter((call) => call[1] === 'set');
    expect(writes).toEqual([[
      IPC_DOMAINS.SETTINGS,
      'set',
      { privacy: { postLaunchScoring: 'auto', posthogEnabled: false } },
    ]]);
  });
});
