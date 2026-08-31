// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { BundledCapabilitiesTab } from '../../../src/renderer/components/features/capabilityHub/BundledCapabilitiesTab';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

describe('BundledCapabilitiesTab', () => {
  let readinessStatus: 'fallback' | 'not_ready';

  beforeEach(() => {
    invoke.mockReset();
    readinessStatus = 'fallback';
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
      states: [],
      loaded: true,
      error: null,
    });
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({
          id: 'builtin.voice-input',
          status: readinessStatus,
          detail: 'Groq fallback',
          installCommand: 'brew install whisper-cpp',
          preservesExternalAssetsOnUninstall: true,
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_LIST) {
        return Promise.resolve([
          { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 2 },
          { id: 'builtin.voice-input', installed: true, version: '1.0.0', revision: 2 },
        ]);
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => cleanup());

  it('keeps degraded readiness and permission pills visible while details are collapsed', async () => {
    render(<BundledCapabilitiesTab />);

    const inputCard = await screen.findByTestId('voice-input-capability-card');
    const readinessWarning = await within(inputCard).findByTestId('voice-input-readiness-warning');
    expect(within(readinessWarning).getByText(zh.capabilityPackages.readiness.fallback)).toBeTruthy();
    expect(within(inputCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel })
      .getAttribute('aria-expanded')).toBe('false');

    const permissionPills = within(inputCard).getByTestId('voice-input-capability-card-permissions');
    for (const permission of zh.capabilityPackages.voiceInput.permissions) {
      expect(within(permissionPills).getByText(permission.split(/[：:]/, 1)[0].trim())).toBeTruthy();
      expect(within(inputCard).queryByText(permission)).toBeNull();
    }
    expect(within(inputCard).queryByText('brew install whisper-cpp')).toBeNull();
    expect(within(inputCard).queryByText(zh.capabilityPackages.assetsPreserved)).toBeNull();
  });

  it('keeps local-only not-ready readiness visible while details are collapsed', async () => {
    readinessStatus = 'not_ready';
    render(<BundledCapabilitiesTab />);

    const warning = await screen.findByTestId('voice-input-readiness-warning');
    expect(within(warning).getByText(zh.capabilityPackages.readiness.notReady)).toBeTruthy();
  });

  it('reveals full permission, readiness, install, and asset details after expansion', async () => {
    render(<BundledCapabilitiesTab />);

    const inputCard = await screen.findByTestId('voice-input-capability-card');
    fireEvent.click(within(inputCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel }));

    for (const permission of zh.capabilityPackages.voiceInput.permissions) {
      expect(within(inputCard).getByText(permission)).toBeTruthy();
    }
    expect(within(inputCard).getAllByText(zh.capabilityPackages.readiness.fallback)).toHaveLength(2);
    expect(within(inputCard).getByText('brew install whisper-cpp')).toBeTruthy();
    expect(within(inputCard).getByText(zh.capabilityPackages.assetsPreserved)).toBeTruthy();

    const liveCard = screen.getByTestId('voice-live-capability-card');
    fireEvent.click(within(liveCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel }));
    for (const permission of zh.capabilityPackages.voiceLive.permissions) {
      expect(within(liveCard).getByText(permission)).toBeTruthy();
    }
    expect(within(liveCard).getByText(zh.capabilityPackages.voiceLive.optionalAssets)).toBeTruthy();
  });

  it('installs through the capability IPC and refreshes the shared store', async () => {
    render(<BundledCapabilitiesTab />);

    const inputCard = await screen.findByTestId('voice-input-capability-card');
    fireEvent.click(within(inputCard).getByRole('button', { name: zh.capabilityPackages.install }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CAPABILITY_STATE_INSTALL,
      'builtin.voice-input',
    ));
    await waitFor(() => expect(
      useBundledCapabilityStore.getState().installed['builtin.voice-input'],
    ).toBe(true));
  });
});
