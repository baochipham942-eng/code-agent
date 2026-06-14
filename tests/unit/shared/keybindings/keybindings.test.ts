import { describe, expect, it } from 'vitest';
import {
  createDefaultKeybindingsSettings,
  detectKeybindingConflicts,
  detectKeybindingSystemWarnings,
  eventToAccelerator,
  formatActionShortcut,
  normalizeAccelerator,
} from '@shared/keybindings';

describe('keybindings registry', () => {
  it('defaults command palette to Cmd+K on macOS and leaves destructive clear chat unbound', () => {
    const settings = createDefaultKeybindingsSettings('darwin');

    expect(settings.bindings['commandPalette.open']).toEqual({
      enabled: true,
      accelerator: 'Cmd+K',
    });
    expect(settings.globalHotkeysEnabled).toBe(true);
    expect(settings.bindings['app.quickAsk']).toEqual({
      enabled: true,
      accelerator: 'Cmd+Shift+A',
    });
    expect(settings.bindings['session.clear']).toEqual({
      enabled: false,
      accelerator: null,
    });
    expect(settings.bindings['session.compact']).toEqual({
      enabled: false,
      accelerator: null,
    });
  });

  it('normalizes modifier order and symbols', () => {
    expect(normalizeAccelerator('Shift+Cmd+p', 'darwin')).toBe('Cmd+Shift+P');
    expect(normalizeAccelerator('⌘⇧P', 'darwin')).toBe('Cmd+Shift+P');
    expect(normalizeAccelerator('CommandOrControl+K', 'win32')).toBe('Ctrl+K');
  });

  it('converts keyboard events to accelerators', () => {
    expect(eventToAccelerator({ key: 'k', metaKey: true }, 'darwin')).toBe('Cmd+K');
    expect(eventToAccelerator({ key: '/', ctrlKey: true }, 'win32')).toBe('Ctrl+/');
    expect(eventToAccelerator({ key: 'Shift', shiftKey: true }, 'darwin')).toBeNull();
  });

  it('formats shortcuts for display per platform', () => {
    const macSettings = createDefaultKeybindingsSettings('darwin');
    const windowsSettings = createDefaultKeybindingsSettings('win32');

    expect(formatActionShortcut(macSettings, 'commandPalette.open', 'darwin')).toBe('⌘K');
    expect(formatActionShortcut(windowsSettings, 'commandPalette.open', 'win32')).toBe('Ctrl+K');
  });

  it('detects conflicts within the same scope only', () => {
    const settings = createDefaultKeybindingsSettings('darwin');
    settings.bindings['session.clear'] = { enabled: true, accelerator: 'Cmd+K' };
    settings.bindings['settings.open'] = { enabled: true, accelerator: 'Cmd+K' };

    const conflicts = detectKeybindingConflicts(settings, 'darwin');

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].actionIds).toEqual(['commandPalette.open', 'session.clear']);
  });

  it('warns about likely system-reserved shortcuts', () => {
    const settings = createDefaultKeybindingsSettings('darwin');
    settings.bindings['app.quickAsk'] = { enabled: true, accelerator: 'Cmd+Space' };

    const warnings = detectKeybindingSystemWarnings(settings, 'darwin');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      actionId: 'app.quickAsk',
      normalizedShortcut: 'Cmd+Space',
    });
  });
});
