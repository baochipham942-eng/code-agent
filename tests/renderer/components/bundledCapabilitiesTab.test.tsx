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
  beforeEach(() => {
    invoke.mockReset();
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
          status: 'fallback',
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

  it('discloses all five permissions, fallback readiness, and asset preservation', async () => {
    render(<BundledCapabilitiesTab />);

    expect(await screen.findByText(zh.capabilityPackages.readiness.fallback)).toBeTruthy();
    for (const permission of zh.capabilityPackages.voiceInput.permissions) {
      expect(screen.getByText(permission)).toBeTruthy();
    }
    expect(screen.getByText(zh.capabilityPackages.assetsPreserved)).toBeTruthy();
    expect(screen.getByText('brew install whisper-cpp')).toBeTruthy();
    for (const permission of zh.capabilityPackages.voiceLive.permissions) {
      expect(screen.getByText(permission)).toBeTruthy();
    }
    expect(screen.getByText(zh.capabilityPackages.voiceLive.optionalAssets)).toBeTruthy();
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
