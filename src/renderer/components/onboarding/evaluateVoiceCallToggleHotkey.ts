import {
  detectKeybindingConflicts,
  detectKeybindingSystemWarnings,
  mergeKeybindingsWithDefaults,
  type KeybindingActionId,
  type KeybindingPlatform,
  type KeybindingsSettings,
} from '@shared/keybindings';

export type VoiceCallToggleHotkeyEvaluation =
  | { ok: true; next: KeybindingsSettings }
  | { ok: false; kind: 'conflict'; actionIds: KeybindingActionId[] }
  | { ok: false; kind: 'system'; reason: string; normalizedShortcut: string };

export function evaluateVoiceCallToggleHotkey(
  settings: KeybindingsSettings | undefined,
  accelerator: string,
  platform: KeybindingPlatform,
): VoiceCallToggleHotkeyEvaluation {
  const merged = mergeKeybindingsWithDefaults(settings, platform);
  const next: KeybindingsSettings = {
    ...merged,
    bindings: {
      ...merged.bindings,
      'voice.callToggle': { enabled: true, accelerator },
    },
  };
  const conflict = detectKeybindingConflicts(next, platform)
    .find((entry) => entry.actionIds.includes('voice.callToggle'));
  if (conflict) {
    return {
      ok: false,
      kind: 'conflict',
      actionIds: conflict.actionIds.filter((id) => id !== 'voice.callToggle'),
    };
  }
  const systemWarning = detectKeybindingSystemWarnings(next, platform)
    .find((entry) => entry.actionId === 'voice.callToggle');
  if (systemWarning) {
    return {
      ok: false,
      kind: 'system',
      reason: systemWarning.reason,
      normalizedShortcut: systemWarning.normalizedShortcut,
    };
  }
  return { ok: true, next };
}
