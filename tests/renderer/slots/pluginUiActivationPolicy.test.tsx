// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import {
  applyPluginUiActivationSettings,
  activatePluginUiWithPolicy,
  unloadPluginUiWithPolicy,
} from '../../../src/renderer/slots/pluginUiActivationPolicy';
import { declareSlot, Slot, slots } from '../../../src/renderer/slots/pluginUiSdk';

const pluginIds = new Set<string>();
const declarations: Array<() => void> = [];

afterEach(async () => {
  cleanup();
  await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
  for (const pluginId of pluginIds) await unloadPluginUiWithPolicy(pluginId);
  pluginIds.clear();
  declarations.splice(0).reverse().forEach((dispose) => dispose());
});

describe('third-party interface plugin activation policy', () => {
  it('V9 defaults the user setting to false', () => {
    expect(DEFAULT_SETTINGS.pluginUi?.thirdPartyEnabled).toBe(false);
  });

  it('V10 does not run third-party registration while the setting is off', async () => {
    const activate = vi.fn();
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
    const loaded = await activatePluginUiWithPolicy('third-party', 'third-party-off', activate);

    expect(loaded).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it('V11 keeps built-in internal features active while the setting is off', async () => {
    const activate = vi.fn();
    pluginIds.add('evaluation-center');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
    const loaded = await activatePluginUiWithPolicy('internal-feature', 'evaluation-center', activate);

    expect(loaded).toBe(true);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('loads explicitly enabled third-party content and removes it when the setting turns off', async () => {
    declarations.push(declareSlot('test.policy.location', {
      kind: 'list',
      scope: 'root',
      props: {},
      declaredBy: 'PluginUiActivationPolicyTest',
      replaceRisk: 'none',
    }));
    pluginIds.add('third-party-on');
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: true } });
    await activatePluginUiWithPolicy('third-party', 'third-party-on', () => {
      slots.register({ name: 'test.policy.location', id: 'content' }, () => <div>THIRD PARTY CONTENT</div>);
    });
    render(<Slot name="test.policy.location" />);
    expect(screen.getByText('THIRD PARTY CONTENT')).toBeTruthy();

    await act(() => applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } }));
    expect(screen.queryByText('THIRD PARTY CONTENT')).toBeNull();
  });
});
