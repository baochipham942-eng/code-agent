import type { GlobalHotkeyRegistrationResult } from './nativeCommandFacade';

export const GLOBAL_HOTKEY_REGISTRATION_CHANGED_EVENT = 'app:globalHotkeyRegistrationChanged';

let latestResults: GlobalHotkeyRegistrationResult[] = [];

function cloneResults(results: readonly GlobalHotkeyRegistrationResult[]): GlobalHotkeyRegistrationResult[] {
  return results.map((result) => ({ ...result }));
}

export function publishGlobalHotkeyRegistrationResults(
  results: readonly GlobalHotkeyRegistrationResult[],
): void {
  latestResults = cloneResults(results);
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<GlobalHotkeyRegistrationResult[]>(
    GLOBAL_HOTKEY_REGISTRATION_CHANGED_EVENT,
    { detail: cloneResults(latestResults) },
  ));
}

export function getGlobalHotkeyRegistrationResults(): GlobalHotkeyRegistrationResult[] {
  return cloneResults(latestResults);
}
