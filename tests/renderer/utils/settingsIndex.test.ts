import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, searchSettings } from '../../../src/renderer/utils/settingsIndex';
import { SETTINGS_TAB_IDS } from '../../../src/renderer/utils/settingsTabs';

describe('settings search index', () => {
  it('covers conversation settings', () => {
    expect(searchSettings('browser').map((entry) => entry.tab)).toContain('conversation');
    expect(searchSettings('路由').map((entry) => entry.tab)).toContain('conversation');
  });

  it('only references registered settings tabs', () => {
    const registered = new Set<string>(SETTINGS_TAB_IDS);
    for (const entry of SETTINGS_INDEX) {
      expect(registered.has(entry.tab)).toBe(true);
    }
  });
});
