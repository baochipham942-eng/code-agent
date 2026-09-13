import { describe, expect, it } from 'vitest';
import {
  KEYBINDING_DEFINITIONS,
  createDefaultKeybindingsSettings,
} from '@shared/keybindings';
import { evaluateVoiceCallToggleHotkey } from '../../../src/renderer/components/onboarding/evaluateVoiceCallToggleHotkey';

describe('evaluateVoiceCallToggleHotkey', () => {
  it('does not ship a default voice.callToggle hotkey or enable it by default', () => {
    const definition = KEYBINDING_DEFINITIONS.find((entry) => entry.id === 'voice.callToggle');
    expect(definition?.enabledByDefault).toBe(false);
    expect(definition?.defaultHotkeys).toEqual({ darwin: null, win32: null, linux: null });
    expect(definition?.risk).toBe('advanced');
    expect(createDefaultKeybindingsSettings('linux').bindings['voice.callToggle']).toEqual({
      enabled: false,
      accelerator: null,
    });
  });

  it('rejects a shortcut that collides with another global action in the same scope', () => {
    const defaults = createDefaultKeybindingsSettings('linux');
    const result = evaluateVoiceCallToggleHotkey(defaults, 'Ctrl+Shift+A', 'linux');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.actionIds).toContain('app.quickAsk');
  });

  it('rejects a system-reserved shortcut and keeps the binding disabled', () => {
    const defaults = createDefaultKeybindingsSettings('linux');
    const result = evaluateVoiceCallToggleHotkey(defaults, 'Alt+Tab', 'linux');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('system');
    expect(defaults.bindings['voice.callToggle']).toEqual({
      enabled: false,
      accelerator: null,
    });
  });

  it('accepts a free shortcut and returns a persistable next settings object', () => {
    const defaults = createDefaultKeybindingsSettings('linux');
    const result = evaluateVoiceCallToggleHotkey(defaults, 'Ctrl+Shift+V', 'linux');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.bindings['voice.callToggle']).toEqual({
      enabled: true,
      accelerator: 'Ctrl+Shift+V',
    });
    expect(defaults.bindings['voice.callToggle']).toEqual({
      enabled: false,
      accelerator: null,
    });
  });
});
