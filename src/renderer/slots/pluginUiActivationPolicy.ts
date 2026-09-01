import type { AppSettings } from '@shared/contract';
import { DEFAULT_THIRD_PARTY_UI_PLUGINS_ENABLED } from '@shared/contract/settings';
import { activatePluginUi, unloadPluginUi } from './pluginUiSdk';

type PluginUiSource = 'internal-feature' | 'third-party';

let thirdPartyEnabled = DEFAULT_THIRD_PARTY_UI_PLUGINS_ENABLED;
const activeThirdPartyPlugins = new Set<string>();

export function isThirdPartyPluginUiEnabled(
  settings?: Pick<AppSettings, 'pluginUi'>,
): boolean {
  return settings?.pluginUi?.thirdPartyEnabled === true;
}

export async function applyPluginUiActivationSettings(
  settings?: Pick<AppSettings, 'pluginUi'>,
): Promise<void> {
  thirdPartyEnabled = isThirdPartyPluginUiEnabled(settings);
  if (thirdPartyEnabled) return;

  const pluginIds = [...activeThirdPartyPlugins];
  activeThirdPartyPlugins.clear();
  await Promise.all(pluginIds.map((pluginId) => unloadPluginUi(pluginId)));
}

export async function activatePluginUiWithPolicy(
  source: PluginUiSource,
  pluginId: string,
  activate: () => unknown | Promise<unknown>,
): Promise<boolean> {
  if (source === 'third-party' && !thirdPartyEnabled) {
    activeThirdPartyPlugins.delete(pluginId);
    await unloadPluginUi(pluginId);
    return false;
  }

  await activatePluginUi(pluginId, activate);
  if (source === 'third-party') activeThirdPartyPlugins.add(pluginId);
  return true;
}

export async function unloadPluginUiWithPolicy(pluginId: string): Promise<void> {
  activeThirdPartyPlugins.delete(pluginId);
  await unloadPluginUi(pluginId);
}
