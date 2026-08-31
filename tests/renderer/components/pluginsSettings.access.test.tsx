// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { PluginsSettings } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const builtinIds = [
  'builtin.imageProcess',
  'builtin.audioProcessing',
  'builtin.videoGeneration',
  'builtin.imageCreation',
  'builtin.musicGeneration',
  'builtin.browserControl',
  'builtin.computerUse',
  'builtin.photoArchive',
] as const;

beforeEach(() => {
  invoke.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST) {
      return Promise.resolve({
        success: true,
        data: [{
          name: 'official',
          source: { source: 'github', repo: 'neo/official' },
          installLocation: '/marketplaces/official',
          lastUpdated: '2026-08-31T00:00:00.000Z',
          pluginCount: 1,
          autoUpdate: true,
        }],
      });
    }
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS) {
      return Promise.resolve({
        success: true,
        data: [{
          name: 'official-web',
          marketplace: 'official',
          source: './official-web',
          description: 'Official catalog plugin',
          skills: ['web'],
        }],
      });
    }
    if (channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED) {
      return Promise.resolve({ success: true, data: [] });
    }
    if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
      return Promise.resolve({
        success: true,
        data: builtinIds.map((id, index) => ({
          id,
          name: `Builtin ${index + 1}`,
          version: '1.0.0',
          description: 'Neo built-in plugin',
          permissions: [],
          state: id === 'builtin.computerUse' ? 'available' : 'active',
          surface: 'tools',
          toolNames: [],
        })),
      });
    }
    if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
      return Promise.resolve({ status: 'fallback' });
    }
    throw new Error(`Unexpected channel ${channel}`);
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  vi.clearAllMocks();
});

describe('PluginsSettings access boundaries', () => {
  it('regular users see all ten first-party plugins and the marketplace catalog, without source management', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    render(<PluginsSettings />);

    expect(screen.getByTestId('voice-live-capability-card')).toBeTruthy();
    expect(screen.getByTestId('voice-input-capability-card')).toBeTruthy();
    for (const id of builtinIds) {
      expect(await screen.findByTestId(`capability-package-${id}`)).toBeTruthy();
    }
    expect(await screen.findByText('official-web')).toBeTruthy();
    expect(screen.queryByTestId('marketplace-source-management')).toBeNull();
  });

  it('administrators retain marketplace source management', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    render(<PluginsSettings />);

    expect(await screen.findByTestId('marketplace-source-management')).toBeTruthy();
  });
});
