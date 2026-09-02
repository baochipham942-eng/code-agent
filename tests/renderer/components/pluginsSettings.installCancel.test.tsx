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

  it('silently closes the import flow when the file dialog is cancelled', async () => {
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE) {
        return Promise.resolve({ success: true, data: null });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.action }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE);
    });
    expect(screen.queryByText(zh.settings.plugins.manualImport.confirmTitle)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a genuine import failure without crashing the page', async () => {
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE) {
        return Promise.resolve({ success: false, error: '插件包校验失败' });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_STATE_READINESS) {
        return Promise.resolve({ status: 'fallback' });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.action }));

    expect((await screen.findByRole('alert')).textContent).toContain('插件包校验失败');
  });

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
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST) {
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

  it('queues local plugin approval in the framework overlay instead of installing from settings', async () => {
    invoke.mockImplementation((channel: string) => {
      if (
        channel === IPC_CHANNELS.MARKETPLACE_LIST
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS
        || channel === IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED
        || channel === IPC_CHANNELS.CAPABILITY_PACKAGE_LIST
      ) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE) {
        return Promise.resolve({
          success: true,
          data: {
            token: 'validated-package-token',
            id: 'local.web-research',
            packageId: '1.0.0-local',
            mode: 'run',
            approvalRequired: true,
            name: '本机网页研究',
            version: '1.0.0',
            description: '读取网页并整理证据。',
            permissions: ['network', 'storage'],
            toolNames: ['research_web'],
            surface: 'tools',
            sourceKind: 'directory',
            sourceLabel: 'web-research',
            sourceTrust: { level: 'unsigned', reason: 'source not verified' },
            requestedUiSlots: [],
            sandbox: { passed: true, summary: '激活与最小工具探针均通过。' },
            expiresAt: Date.now() + 60_000,
          },
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM) {
        return Promise.resolve({
          success: true,
          data: { id: 'local.web-research', version: '1.0.0', toolNames: ['research_web'] },
        });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.action }));

    expect(await screen.findByText(
      `${zh.settings.plugins.manualImport.approvalQueued}本机网页研究`,
    )).toBeTruthy();
    expect(screen.queryByText(zh.settings.plugins.manualImport.confirmTitle)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM,
      expect.anything(),
    );
  });

  it('installs bundled Computer Use only after disclosing Accessibility and Screen Recording', async () => {
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
              description: '图片处理',
              permissions: ['filesystem'],
              state: 'active',
              toolNames: ['image_process'],
            },
            {
              id: 'builtin.computerUse',
              name: 'Computer Use',
              version: '1.0.0',
              description: 'macOS 桌面控制',
              permissions: ['filesystem', 'shell', 'accessibility', 'screen-recording'],
              state: 'available',
              toolNames: [],
            },
          ],
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_BUNDLED) {
        return Promise.resolve({
          success: true,
          data: {
            token: 'bundled-cua-token',
            id: 'builtin.computerUse',
            packageId: 'builtin-1.0.0',
            mode: 'run',
            approvalRequired: false,
            name: 'Computer Use',
            version: '1.0.0',
            description: 'macOS 桌面控制',
            permissions: ['filesystem', 'shell', 'accessibility', 'screen-recording'],
            toolNames: ['cua-driver'],
            surface: 'tools',
            sourceKind: 'bundled',
            sourceLabel: 'Agent Neo',
            sourceTrust: { level: 'signed', reason: 'built in', keyId: 'neo-bundled' },
            requestedUiSlots: [],
            sandbox: { passed: true, summary: '内置能力已校验' },
            expiresAt: Date.now() + 60_000,
          },
        });
      }
      if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM) {
        return Promise.resolve({
          success: true,
          data: { id: 'builtin.computerUse', version: '1.0.0', toolNames: ['cua-driver'] },
        });
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(<PluginsSettings />);
    expect(await screen.findByText('Image Process')).toBeTruthy();
    expect(screen.getByText('Computer Use')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.plugins.manualImport.install }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM,
        'bundled-cua-token',
        false,
      );
    });
  });
});
