import { useEffect, useMemo, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import {
  createDefaultKeybindingsSettings,
  getCurrentKeybindingPlatform,
  mergeKeybindingsWithDefaults,
  type KeybindingPlatform,
  type KeybindingsSettings,
} from '@shared/keybindings';
import ipcService from '../services/ipcService';
import { createLogger } from '../utils/logger';

export const KEYBINDINGS_CHANGED_EVENT = 'app:keybindingsChanged';

const logger = createLogger('KeybindingsSettingsRuntime');

export async function loadKeybindingsSettings(platform: KeybindingPlatform): Promise<KeybindingsSettings> {
  const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
  return mergeKeybindingsWithDefaults(settings?.keybindings, platform);
}

export function emitKeybindingsChanged(keybindings: KeybindingsSettings): void {
  window.dispatchEvent(new CustomEvent<KeybindingsSettings>(KEYBINDINGS_CHANGED_EVENT, {
    detail: keybindings,
  }));
}

export function useKeybindingsSettings(): {
  keybindings: KeybindingsSettings;
  platform: KeybindingPlatform;
} {
  const platform = useMemo(() => getCurrentKeybindingPlatform(), []);
  const [keybindings, setKeybindings] = useState<KeybindingsSettings>(() =>
    createDefaultKeybindingsSettings(platform)
  );

  useEffect(() => {
    let cancelled = false;
    void loadKeybindingsSettings(platform)
      .then((loaded) => {
        if (!cancelled) setKeybindings(loaded);
      })
      .catch((error) => {
        logger.error('Failed to load keybindings settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const next = (event as CustomEvent<KeybindingsSettings>).detail;
      if (!next) return;
      setKeybindings(mergeKeybindingsWithDefaults(next, platform));
    };
    window.addEventListener(KEYBINDINGS_CHANGED_EVENT, handleChange);
    return () => {
      window.removeEventListener(KEYBINDINGS_CHANGED_EVENT, handleChange);
    };
  }, [platform]);

  return { keybindings, platform };
}
