// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';
import type { UiSlotName } from '../../../src/shared/contract/uiSlots';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain: vi.fn() },
}));

import { installInternalSdk } from '../../../src/renderer/internalFeatures/internalSdk';
import { RENDERER_INTERNAL_SDK_VERSION } from '../../../src/renderer/internalFeatures/internalSdkVersion';
import {
  ConversationTurnTailSlot,
  ConversationTurnTailSlotHost,
  HubTabSlotHost,
  NavAccountItemSlotHost,
  SettingsSectionSlotHost,
  ShellOverlaySlotHost,
  WorkspacePageSlotHost,
} from '../../../src/renderer/slots/productSlotHosts';
import {
  applyPluginUiActivationSettings,
} from '../../../src/renderer/slots/pluginUiActivationPolicy';
import { refreshThirdPartyPluginUi } from '../../../src/renderer/slots/thirdPartyPluginUiLoader';

function installed(
  id: string,
  location: UiSlotName,
  overrides: Partial<NonNullable<InstalledCapabilityPackage['pluginUi']>> = {},
): InstalledCapabilityPackage {
  return {
    id,
    name: `插件 ${id}`,
    version: '1.0.0',
    description: '真实 renderer bundle 测试夹具',
    permissions: [],
    state: 'active',
    surface: 'ui',
    toolNames: [],
    pluginUi: {
      sdkVersion: { renderer: RENDERER_INTERNAL_SDK_VERSION },
      rendererEntry: 'dist/renderer/index.js',
      rendererStyles: 'dist/renderer/index.css',
      loadedHash: `hash-${id}`,
      sourceTrust: { level: 'signed', reason: 'fixture' },
      requestedUiSlots: [location],
      ...overrides,
    },
  };
}

function globalName(pluginId: string): string {
  return `__neoPluginUi_${pluginId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function bundleSource(pluginId: string, location: UiSlotName, crashes = false): string {
  const target = location === 'workspace.page'
    ? `{ name: ${JSON.stringify(location)}, key: ${JSON.stringify(pluginId)} }`
    : `{ name: ${JSON.stringify(location)}, id: 'fixture-entry' }`;
  const componentBody = crashes
    ? `throw new Error('fixture render crash');`
    : `return React.createElement('div', { 'data-testid': 'loaded-third-party-ui' }, 'THIRD PARTY UI');`;
  return `
(() => {
  const sdk = window.__NEO_INTERNAL_SDK__;
  const React = sdk.modules.react;
  const { slots } = sdk.modules['@renderer/slots/pluginUiSdk'];
  window[${JSON.stringify(globalName(pluginId))}] = {
    activate() {
      slots.inject(${JSON.stringify(location)}, () => slots.register(${target}, () => { ${componentBody} }));
      slots.addStyle('.third-party-fixture { color: rgb(1, 2, 3); }');
    }
  };
})();
`;
}

function currentScript(pluginId: string): HTMLScriptElement | null {
  return Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-plugin-ui]'))
    .find((script) => script.dataset.pluginUi === pluginId) ?? null;
}

async function executeBundle(pluginId: string, location: UiSlotName, crashes = false): Promise<void> {
  const script = await waitFor(() => {
    const current = currentScript(pluginId);
    if (!current) throw new Error(`missing renderer script for ${pluginId}`);
    return current;
  });
  Function('window', bundleSource(pluginId, location, crashes))(window);
  fireEvent.load(script);
}

async function completeLoadIfBundleWasInjected(
  loading: Promise<void>,
  pluginId: string,
  location: UiSlotName,
): Promise<void> {
  const outcome = await Promise.race([
    loading.then(() => 'completed' as const),
    waitFor(() => {
      if (!currentScript(pluginId)) throw new Error('bundle not injected');
      return 'injected' as const;
    }).catch(() => 'completed' as const),
  ]);
  if (outcome === 'injected') await executeBundle(pluginId, location);
  await loading;
}

function renderLocation(location: UiSlotName): ReturnType<typeof render> {
  switch (location) {
    case 'nav.account.item':
      return render(<NavAccountItemSlotHost onClose={() => undefined} />);
    case 'hub.tab':
      return render(<HubTabSlotHost active />);
    case 'settings.section':
      return render(<SettingsSectionSlotHost />);
    case 'workspace.page':
      return render(<WorkspacePageSlotHost fallback={<div>SHIPPED WORKSPACE</div>} />);
    case 'shell.overlay':
      return render(<ShellOverlaySlotHost />);
    case 'conversation.turnTail':
      return render(<><ConversationTurnTailSlotHost /><ConversationTurnTailSlot sessionId="s1" turnId="t1" /></>);
  }
}

beforeEach(() => {
  installInternalSdk();
  invoke.mockResolvedValue({ success: true, data: undefined });
});

afterEach(async () => {
  cleanup();
  await refreshThirdPartyPluginUi([]);
  await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
  document.querySelectorAll('[data-plugin-ui]').forEach((node) => node.remove());
  vi.clearAllMocks();
});

describe('third-party renderer bundle loader', () => {
  it('V1 keeps the real loader on the L5 admission entry', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/slots/thirdPartyPluginUiLoader.ts'),
      'utf8',
    );
    expect(source).toContain("activatePluginUiWithPolicy('third-party', plugin.id");
    expect(source).not.toMatch(/\bactivatePluginUi\s*\(/u);
  });

  it.each([
    'nav.account.item',
    'hub.tab',
    'shell.overlay',
    'conversation.turnTail',
  ] as const)('V2-V5 keeps unsigned plugin UI out of restricted product location %s', async (location) => {
    const plugin = installed(`unsigned-${location.replaceAll('.', '-')}`, location, {
      sourceTrust: { level: 'unsigned', reason: 'fixture' },
    });
    renderLocation(location);
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const loading = refreshThirdPartyPluginUi([plugin]);
    await completeLoadIfBundleWasInjected(loading, plugin.id, location);

    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('ui-load-state'),
      plugin.id,
      expect.stringContaining('来源未经验证'),
    );
  });

  it('V6/V7/V12 runs a real bundle through off → on → off → on → uninstall with zero residue', async () => {
    const plugin = installed('real-settings-plugin', 'settings.section', {
      sourceTrust: { level: 'unsigned', reason: 'fixture' },
    });
    renderLocation('settings.section');

    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
    const disabledLoad = refreshThirdPartyPluginUi([plugin]);
    await completeLoadIfBundleWasInjected(disabledLoad, plugin.id, 'settings.section');
    expect(currentScript(plugin.id)).toBeNull();
    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();

    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const firstLoad = refreshThirdPartyPluginUi([plugin]);
    await act(async () => {
      await executeBundle(plugin.id, 'settings.section');
      await firstLoad;
    });
    expect(screen.getByTestId('loaded-third-party-ui')).toBeTruthy();
    expect(document.querySelector(`link[data-plugin-ui="${plugin.id}"]`)).toBeTruthy();
    expect(document.querySelector(`style[data-plugin-ui="${plugin.id}"]`)).toBeTruthy();

    await act(() => applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } }));
    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();
    expect(document.querySelector(`[data-plugin-ui="${plugin.id}"]`)).toBeNull();
    expect((window as unknown as Record<string, unknown>)[globalName(plugin.id)]).toBeUndefined();

    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const secondLoad = refreshThirdPartyPluginUi([plugin]);
    await act(async () => {
      await executeBundle(plugin.id, 'settings.section');
      await secondLoad;
    });
    expect(screen.getByTestId('loaded-third-party-ui')).toBeTruthy();

    await act(() => refreshThirdPartyPluginUi([]));
    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();
    expect(document.querySelector(`[data-plugin-ui="${plugin.id}"]`)).toBeNull();
  });

  it('V9 rejects a mismatched renderer contract before injecting the bundle', async () => {
    const plugin = installed('mismatched-ui', 'settings.section', {
      sdkVersion: { renderer: 'deadbeef' },
    });
    renderLocation('settings.section');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const loading = refreshThirdPartyPluginUi([plugin]);
    await completeLoadIfBundleWasInjected(loading, plugin.id, 'settings.section');

    expect(currentScript(plugin.id)).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('ui-load-state'),
      plugin.id,
      '这个插件的界面版本与当前应用不匹配，请重新安装',
    );
  });

  it('rejects a bundle that registers an unapproved location before that host is mounted', async () => {
    const plugin = installed('unapproved-late-location', 'settings.section');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const loading = refreshThirdPartyPluginUi([plugin]);
    await executeBundle(plugin.id, 'hub.tab');
    await loading;
    renderLocation('hub.tab');

    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('ui-load-state'),
      plugin.id,
      expect.stringContaining('没有获准'),
    );
  });

  it('V10 records a script load failure on the existing installed-package error state', async () => {
    const plugin = installed('failed-ui', 'settings.section');
    renderLocation('settings.section');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const loading = refreshThirdPartyPluginUi([plugin]);
    const script = await waitFor(() => {
      const current = currentScript(plugin.id);
      if (!current) throw new Error('missing failure fixture script');
      return current;
    });
    await act(async () => {
      fireEvent.error(script);
      await loading;
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('ui-load-state'),
      plugin.id,
      expect.stringContaining('加载失败'),
    );
    expect(document.querySelector(`[data-plugin-ui="${plugin.id}"]`)).toBeNull();
  });

  it('V11 withdraws a crashing third-party keyed page and restores shipped UI', async () => {
    const plugin = installed('crashing-workspace', 'workspace.page');
    renderLocation('workspace.page');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    const loading = refreshThirdPartyPluginUi([plugin]);
    await act(async () => {
      await executeBundle(plugin.id, 'workspace.page', true);
      await loading;
    });

    expect(await screen.findByText('SHIPPED WORKSPACE')).toBeTruthy();
    expect(screen.queryByTestId('loaded-third-party-ui')).toBeNull();
  });
});
