import type { KeybindingPlatform } from './types';
import { getCurrentKeybindingPlatform } from './defaults';

const MODIFIER_ORDER = ['Cmd', 'Ctrl', 'Alt', 'Shift'] as const;

function symbolToToken(input: string): string {
  return input
    .replace(/⌘/g, 'Cmd+')
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/Esc\b/gi, 'Escape');
}

function normalizeToken(token: string, platform: KeybindingPlatform): string | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return null;
  if (['cmd', 'command', 'meta', 'super'].includes(normalized)) return 'Cmd';
  if (['commandorcontrol', 'cmdorctrl', 'mod'].includes(normalized)) {
    return platform === 'darwin' ? 'Cmd' : 'Ctrl';
  }
  if (['ctrl', 'control'].includes(normalized)) return 'Ctrl';
  if (['alt', 'option', 'opt'].includes(normalized)) return 'Alt';
  if (normalized === 'shift') return 'Shift';
  if (['esc', 'escape'].includes(normalized)) return 'Escape';
  if (normalized === 'space') return 'Space';
  if (normalized === 'return') return 'Enter';
  if (normalized === 'comma') return ',';
  if (normalized === 'slash') return '/';
  if (token.length === 1) return token.toUpperCase();
  return token.slice(0, 1).toUpperCase() + token.slice(1);
}

export function normalizeAccelerator(
  accelerator: string | null | undefined,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string | null {
  if (!accelerator?.trim()) return null;
  const tokens = symbolToToken(accelerator)
    .split('+')
    .map((token) => normalizeToken(token, platform))
    .filter((token): token is string => Boolean(token));

  if (tokens.length === 0) return null;

  const modifiers = MODIFIER_ORDER.filter((modifier) => tokens.includes(modifier));
  const key = [...tokens].reverse().find((token) => !MODIFIER_ORDER.includes(token as typeof MODIFIER_ORDER[number]));
  if (!key) return modifiers.join('+') || null;
  return [...modifiers, key].join('+');
}
