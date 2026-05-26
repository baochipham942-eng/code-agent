import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasSeenUpdatePromptForClientVersion,
  isOptionalUpdateAvailable,
  markUpdatePromptSeenForClientVersion,
  shouldShowOptionalUpdatePrompt,
} from '../../../src/renderer/utils/updatePrompt';

function createLocalStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('updatePrompt', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tracks prompt visibility per installed client version', () => {
    expect(hasSeenUpdatePromptForClientVersion('0.16.75')).toBe(false);

    markUpdatePromptSeenForClientVersion('0.16.75');

    expect(hasSeenUpdatePromptForClientVersion('0.16.75')).toBe(true);
    expect(hasSeenUpdatePromptForClientVersion('0.16.76')).toBe(false);
  });

  it('shows only optional updates that were not seen for this client version', () => {
    const updateInfo = {
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
    };

    expect(shouldShowOptionalUpdatePrompt(updateInfo)).toBe(true);

    markUpdatePromptSeenForClientVersion('0.16.75');

    expect(shouldShowOptionalUpdatePrompt(updateInfo)).toBe(false);
    expect(shouldShowOptionalUpdatePrompt({ ...updateInfo, forceUpdate: true })).toBe(false);
    expect(shouldShowOptionalUpdatePrompt({ ...updateInfo, hasUpdate: false })).toBe(false);
  });

  it('keeps the persistent sidebar update entry independent from prompt seen state', () => {
    const updateInfo = {
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
    };

    markUpdatePromptSeenForClientVersion('0.16.75');

    expect(shouldShowOptionalUpdatePrompt(updateInfo)).toBe(false);
    expect(isOptionalUpdateAvailable(updateInfo)).toBe(true);
    expect(isOptionalUpdateAvailable({ ...updateInfo, forceUpdate: true })).toBe(false);
  });
});
