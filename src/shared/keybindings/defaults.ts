import { KEYBINDING_DEFINITION_BY_ID, KEYBINDING_DEFINITIONS } from './actions';
import type {
  KeybindingActionId,
  KeybindingPlatform,
  KeybindingSetting,
  KeybindingsSettings,
} from './types';

export function getKeybindingPlatformFromNodePlatform(platform: NodeJS.Platform | string): KeybindingPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

export function getCurrentKeybindingPlatform(): KeybindingPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
}

export function createDefaultKeybindingsSettings(
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): KeybindingsSettings {
  const bindings: KeybindingsSettings['bindings'] = {};
  for (const definition of KEYBINDING_DEFINITIONS) {
    bindings[definition.id] = {
      enabled: definition.enabledByDefault,
      accelerator: definition.defaultHotkeys[platform] ?? null,
    };
  }
  return {
    version: 1,
    platform,
    globalHotkeysEnabled: true,
    bindings,
  };
}

export function mergeKeybindingsWithDefaults(
  settings: KeybindingsSettings | undefined,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): KeybindingsSettings {
  const defaults = createDefaultKeybindingsSettings(platform);
  if (!settings) return defaults;
  return {
    ...defaults,
    ...settings,
    version: 1,
    platform: settings.platform ?? platform,
    bindings: {
      ...defaults.bindings,
      ...settings.bindings,
    },
  };
}

export function getDefaultKeybinding(
  actionId: KeybindingActionId,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): KeybindingSetting | null {
  const definition = KEYBINDING_DEFINITION_BY_ID.get(actionId);
  if (!definition) return null;
  return {
    enabled: definition.enabledByDefault,
    accelerator: definition.defaultHotkeys[platform] ?? null,
  };
}

export function getKeybindingSetting(
  settings: KeybindingsSettings | undefined,
  actionId: KeybindingActionId,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): KeybindingSetting {
  const merged = mergeKeybindingsWithDefaults(settings, platform);
  return merged.bindings[actionId] || { enabled: false, accelerator: null };
}

export function getKeybindingAccelerator(
  settings: KeybindingsSettings | undefined,
  actionId: KeybindingActionId,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string | null {
  const setting = getKeybindingSetting(settings, actionId, platform);
  return setting.enabled ? setting.accelerator : null;
}
