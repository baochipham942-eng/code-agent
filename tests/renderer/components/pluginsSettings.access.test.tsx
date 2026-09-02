// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invoke = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ tauri: false }));
const pickNativeFile = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeFile,
}));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isTauriMode: () => platform.tauri,
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
  platform.tauri = false;
  pickNativeFile.mockReset();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('PluginsSettings access boundaries', () => {
  it('regular users see only bundled voice and first-party/local package surfaces', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    render(<PluginsSettings />);

    const availablePlugins = screen.getByTestId('available-plugins-list');
    expect(within(availablePlugins).getByTestId('voice-live-capability-card')).toBeTruthy();
    expect(within(availablePlugins).getByTestId('voice-input-capability-card')).toBeTruthy();
    expect(screen.getAllByText(zh.settings.plugins.manualImport.title)).toHaveLength(1);
    expect(screen.getByRole('button', { name: zh.settings.plugins.manualImport.action })).toBeTruthy();
    for (const id of builtinIds) {
      expect(await within(availablePlugins).findByTestId(`capability-package-${id}`)).toBeTruthy();
    }
    expect(screen.queryByText('official-web')).toBeNull();
    expect(screen.queryByText(zh.settings.plugins.installed.title)).toBeNull();
    expect(screen.queryByText(zh.settings.plugins.marketplace.title)).toBeNull();
    expect(screen.queryByText(zh.settings.plugins.overview.title)).toBeNull();
    expect(screen.queryByText(zh.settings.plugins.completeness.title)).toBeNull();
    expect(screen.queryByText(zh.settings.plugins.visibleList.title)).toBeNull();
    expect(screen.queryByTestId('marketplace-source-management')).toBeNull();
  });

  it('administrators retain marketplace management and all diagnostics', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    render(<PluginsSettings />);

    expect(await screen.findByText('official-web')).toBeTruthy();
    expect(screen.getByText(zh.settings.plugins.installed.title)).toBeTruthy();
    expect(screen.getByText(zh.settings.plugins.marketplace.title)).toBeTruthy();
    expect(screen.getByText(zh.settings.plugins.overview.title)).toBeTruthy();
    expect(screen.getByText(zh.settings.plugins.completeness.title)).toBeTruthy();
    expect(screen.getByText(zh.settings.plugins.visibleList.title)).toBeTruthy();
    expect(await screen.findByTestId('marketplace-source-management')).toBeTruthy();
  });

  it('keeps first-party uninstall and local import available to regular users', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({
          success: true,
          data: [{
            id: 'builtin.imageProcess',
            name: 'Image Process',
            version: '1.0.0',
            description: 'First-party image plugin',
            permissions: [],
            state: 'active',
            surface: 'tools',
            toolNames: ['image_process'],
          }],
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL) {
        return Promise.resolve({ success: true, data: undefined });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE) {
        return Promise.resolve({
          success: true,
          data: {
            token: 'local-import-token',
            id: 'local.research',
            packageId: '1.0.0-local',
            mode: 'run',
            approvalRequired: true,
            name: 'Local Research',
            version: '1.0.0',
            description: 'Locally imported plugin',
            permissions: [],
            toolNames: ['local_research'],
            surface: 'tools',
            sourceKind: 'directory',
            sourceLabel: 'local-research',
            sourceTrust: { level: 'unsigned', reason: 'source not verified' },
            requestedUiSlots: [],
            sandbox: { passed: true, summary: 'ready' },
            expiresAt: Date.now() + 60_000,
          },
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM) {
        return Promise.resolve({
          success: true,
          data: { id: 'local.research', version: '1.0.0', toolNames: ['local_research'] },
        });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    const packageCard = await screen.findByTestId('capability-package-builtin.imageProcess');
    fireEvent.click(within(packageCard).getByRole('button', { name: zh.settings.plugins.manualImport.uninstall }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL,
        'builtin.imageProcess',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: zh.settings.plugins.manualImport.action }));
    expect(await screen.findByText(
      `${zh.settings.plugins.manualImport.approvalQueued}Local Research`,
    )).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, expect.anything());
  });

  it('uses the same plugin card anatomy for first-party packages', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({
          success: true,
          data: [
            {
              id: 'builtin.imageProcess',
              name: 'Image Process',
              version: '1.0.0',
              description: 'First-party image plugin',
              permissions: ['filesystem', 'network'],
              state: 'active',
              surface: 'tools',
              toolNames: ['image_process'],
            },
            {
              id: 'builtin.emptyTools',
              name: 'Empty Tools',
              version: '1.0.0',
              description: 'No contributed tools yet',
              permissions: [],
              state: 'active',
              surface: 'tools',
              toolNames: [],
            },
          ],
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);

    const imageCard = await screen.findByTestId('capability-package-builtin.imageProcess');
    expect(imageCard.getAttribute('data-plugin-card')).toBe('unified');
    expect(within(imageCard).getByTestId('capability-package-builtin.imageProcess-icon')).toBeTruthy();
    expect(within(imageCard).getByText('v1.0.0')).toBeTruthy();
    expect(within(imageCard).getByText(`1${zh.settings.plugins.manualImport.toolsSuffix}`)).toBeTruthy();
    const permissions = within(imageCard).getByTestId('capability-package-builtin.imageProcess-permissions');
    expect(within(permissions).getByText(zh.capabilityPackages.permissionText.labels.filesystem)).toBeTruthy();
    expect(within(permissions).getByText(zh.capabilityPackages.permissionText.labels.network)).toBeTruthy();
    expect(within(imageCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel })).toBeTruthy();
    fireEvent.click(within(imageCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel }));
    expect(within(imageCard).getByText(
      `网络：${zh.capabilityPackages.permissionText.descriptions.network}`,
    )).toBeTruthy();

    const emptyCard = await screen.findByTestId('capability-package-builtin.emptyTools');
    expect(within(emptyCard).queryByText(`0${zh.settings.plugins.manualImport.toolsSuffix}`)).toBeNull();
    fireEvent.click(within(emptyCard).getByRole('button', { name: zh.capabilityPackages.detailsLabel }));
    expect(within(emptyCard).getByText(zh.settings.plugins.manualImport.noPermissions)).toBeTruthy();
    expect(document.body.textContent).not.toContain('访问网络与服务凭据');
    expect(document.body.textContent).not.toContain('文件系统（可选）');
  });

  it('routes a Tauri native file pick through the path staging IPC', async () => {
    platform.tauri = true;
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    pickNativeFile.mockResolvedValue('/Users/linchen/Downloads/local-plugin.zip');
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_PATH) {
        return Promise.resolve({
          success: true,
          data: {
            token: 'tauri-import-token',
            id: 'local.tauri-import',
            packageId: '1.0.0-tauri',
            mode: 'run',
            approvalRequired: true,
            name: 'Tauri Import',
            version: '1.0.0',
            description: 'Imported from native picker',
            permissions: [],
            toolNames: ['tauri_import'],
            surface: 'tools',
            sourceKind: 'zip',
            sourceLabel: 'local-plugin.zip',
            sourceTrust: { level: 'unsigned', reason: 'source not verified' },
            requestedUiSlots: [],
            sandbox: { passed: true, summary: 'ready' },
            expiresAt: Date.now() + 60_000,
          },
        });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.action }));

    expect(await screen.findByText(
      `${zh.settings.plugins.manualImport.approvalQueued}Tauri Import`,
    )).toBeTruthy();
    expect(pickNativeFile).toHaveBeenCalledWith({
      title: zh.settings.plugins.manualImport.action,
      extensions: ['zip', 'json'],
    });
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_PATH,
      '/Users/linchen/Downloads/local-plugin.zip',
    );
    expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE);
  });

  it('surfaces an explicit local import route error when the IPC picker is missing', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE) return undefined;
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.action }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      zh.settings.plugins.manualImport.importUnavailable,
    );
  });

  it('waits for an initially unavailable bridge and loads without an error notice once ready', async () => {
    vi.useFakeTimers();
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    let bridgeReady = false;
    invoke.mockImplementation((channel: string) => {
      if (!bridgeReady) return undefined;
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({
          success: true,
          data: [{
            id: 'local.bridge-ready',
            name: 'Bridge Ready Plugin',
            version: '1.0.0',
            description: 'Loaded after bridge readiness',
            permissions: [],
            state: 'active',
            surface: 'tools',
            toolNames: ['bridge_ready'],
          }],
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<PluginsSettings />);
    await act(async () => Promise.resolve());
    expect(document.body.textContent).not.toContain(zh.settings.plugins.loadErrors.marketplaces);

    bridgeReady = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });

    expect(screen.getByTestId('capability-package-local.bridge-ready')).toBeTruthy();
    expect(document.body.textContent).not.toContain(zh.settings.plugins.loadErrors.marketplaces);
    expect(invoke.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST)).toHaveLength(2);
  });

  it('accepts the HTTP bridge unwrapped capability package list without an error notice', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve([{
          id: 'local.http-bridge',
          name: 'HTTP Bridge Plugin',
          version: '1.0.0',
          description: 'Unwrapped by the HTTP transport',
          permissions: [],
          state: 'active',
          surface: 'tools',
          toolNames: ['http_bridge'],
        }]);
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<PluginsSettings />);

    expect(await screen.findByTestId('capability-package-local.http-bridge')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses a non-empty fallback when capability package loading fails without an error message', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
        return Promise.resolve({ success: false, error: undefined });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<PluginsSettings />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.trim()).toBe(zh.settings.plugins.errors.operationFailed);
  });

  it('still surfaces genuine marketplace failures', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.MARKETPLACE_LIST) {
        return Promise.resolve({ success: false, error: 'marketplace backend rejected the request' });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<PluginsSettings />);

    expect(await screen.findByText('marketplace backend rejected the request')).toBeTruthy();
  });
});
