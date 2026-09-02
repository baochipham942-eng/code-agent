// @vitest-environment jsdom
import React from 'react';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain: vi.fn() },
}));

import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { ManualCapabilityPackageService } from '../../../src/host/services/capabilities/manualCapabilityPackageService';
import { PluginRegistry } from '../../../src/host/plugins/pluginRegistry';
import { createInternalFeaturesRouter } from '../../../src/web/routes/internalFeatures';
import { installInternalSdk } from '../../../src/renderer/internalFeatures/internalSdk';
import { RENDERER_INTERNAL_SDK_VERSION } from '../../../src/renderer/internalFeatures/internalSdkVersion';
import { SettingsSectionSlotHost } from '../../../src/renderer/slots/productSlotHosts';
import { applyPluginUiActivationSettings } from '../../../src/renderer/slots/pluginUiActivationPolicy';
import { refreshThirdPartyPluginUi } from '../../../src/renderer/slots/thirdPartyPluginUiLoader';

const pluginId = 'integration-third-party-ui';
let tempRoot: string;
let pluginsDir: string;
let registry: PluginRegistry;
let service: ManualCapabilityPackageService;
let server: http.Server;
let baseUrl: string;
let originalEnv: Record<string, string | undefined>;

function pluginGlobalName(): string {
  return `__neoPluginUi_${pluginId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function rendererBundle(): string {
  return `
(() => {
  const sdk = window.__NEO_INTERNAL_SDK__;
  const React = sdk.modules.react;
  const { slots } = sdk.modules['@renderer/slots/pluginUiSdk'];
  window[${JSON.stringify(pluginGlobalName())}] = {
    activate() {
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'integration-entry' },
        () => React.createElement('div', { 'data-testid': 'integration-plugin-ui' }, 'INTEGRATION PLUGIN UI')
      ));
      slots.addStyle('.integration-plugin-ui { color: rgb(5, 6, 7); }');
    }
  };
})();
`;
}

async function writeSourcePackage(): Promise<string> {
  const sourceDir = path.join(tempRoot, 'source-package');
  await fs.mkdir(path.join(sourceDir, 'dist', 'renderer'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'plugin.json'), JSON.stringify({
    id: pluginId,
    name: '集成测试插件',
    version: '1.0.0',
    description: '验证第三方插件界面装载全链',
    main: 'index.js',
    permissions: [],
    surfaces: ['ui'],
    uiSlots: ['settings.section'],
    pluginUi: {
      sdkVersion: { renderer: RENDERER_INTERNAL_SDK_VERSION },
      rendererEntry: 'dist/renderer/index.js',
      rendererStyles: 'dist/renderer/index.css',
    },
  }), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'index.js'), 'module.exports = { async activate() {} };', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'dist', 'renderer', 'index.js'), rendererBundle(), 'utf8');
  await fs.writeFile(path.join(sourceDir, 'dist', 'renderer', 'index.css'), '.integration-plugin-ui {}', 'utf8');
  return sourceDir;
}

async function executeServedBundle(source: string): Promise<void> {
  const script = await waitFor(() => {
    const current = document.querySelector<HTMLScriptElement>(`script[data-plugin-ui="${pluginId}"]`);
    if (!current) throw new Error('renderer script not injected');
    return current;
  });
  Function('window', source)(window);
  fireEvent.load(script);
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-plugin-ui-integration-'));
  pluginsDir = path.join(tempRoot, 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  registry = new PluginRegistry();
  service = new ManualCapabilityPackageService({
    pluginsDir: () => pluginsDir,
    registry,
    useOsSandbox: false,
    isCurrentUserAdmin: () => true,
    internalFeatureRuntime: {
      isLoaded: () => false,
      load: async () => undefined,
      loadedHash: () => undefined,
      unload: async () => undefined,
    },
  });
  originalEnv = {
    CODE_AGENT_WEB_MODE: process.env.CODE_AGENT_WEB_MODE,
    CODE_AGENT_E2E: process.env.CODE_AGENT_E2E,
  };
  process.env.CODE_AGENT_WEB_MODE = 'true';
  process.env.CODE_AGENT_E2E = '1';
  installInternalSdk();
  invoke.mockImplementation(async (channel: string, id: string, error?: string) => {
    if (channel === IPC_CHANNELS.CAPABILITY_PACKAGE_UI_LOAD_STATE) {
      await service.reportPluginUiLoadState(id, error);
      return { success: true, data: undefined };
    }
    throw new Error(`unexpected IPC channel ${channel}`);
  });
});

afterEach(async () => {
  cleanup();
  await refreshThirdPartyPluginUi([]);
  await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  registry.pauseWatching();
  await fs.rm(tempRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.clearAllMocks();
});

describe('third-party UI package lifecycle integration', () => {
  it('installs, serves, renders, disables, reenables, and uninstalls an actual bundle', async () => {
    const sourceDir = await writeSourcePackage();
    const preview = await service.stage(sourceDir);
    await service.confirm(preview.token);
    const installed = (await service.list()).find((item) => item.id === pluginId);
    if (!installed) throw new Error('installed package projection missing');

    const app = express();
    app.use(createInternalFeaturesRouter({
      runtime: { isLoaded: () => false, loadedHash: () => undefined },
      registry,
      pluginsDir,
    }));
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not get a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/plugin-ui/${pluginId}/index.js`);
    expect(response.status).toBe(200);
    const servedBundle = await response.text();

    render(<SettingsSectionSlotHost />);
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const firstLoad = refreshThirdPartyPluginUi([installed]);
    await act(async () => {
      await executeServedBundle(servedBundle);
      await firstLoad;
    });
    expect(screen.getByTestId('integration-plugin-ui')).toBeTruthy();
    expect((await service.list()).find((item) => item.id === pluginId)?.state).toBe('active');

    await act(() => applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } }));
    expect(screen.queryByTestId('integration-plugin-ui')).toBeNull();

    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const restarted = (await service.list()).find((item) => item.id === pluginId);
    if (!restarted) throw new Error('restarted package projection missing');
    const secondLoad = refreshThirdPartyPluginUi([restarted]);
    await act(async () => {
      await executeServedBundle(servedBundle);
      await secondLoad;
    });
    expect(screen.getByTestId('integration-plugin-ui')).toBeTruthy();

    await service.uninstall(pluginId);
    const remainingPackages = await service.list();
    await act(() => refreshThirdPartyPluginUi(remainingPackages));
    expect(screen.queryByTestId('integration-plugin-ui')).toBeNull();
    expect(document.querySelector(`[data-plugin-ui="${pluginId}"]`)).toBeNull();
    expect((window as unknown as Record<string, unknown>)[pluginGlobalName()]).toBeUndefined();
  });
});
