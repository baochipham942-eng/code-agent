import { getCurrentKeybindingPlatform } from './defaults';
import { normalizeAccelerator } from './normalize';
import type { KeybindingPlatform } from './types';

export interface KeybindingEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function getEventKey(event: KeybindingEventLike): string {
  if (event.altKey && event.code) {
    const letterMatch = /^Key([A-Z])$/.exec(event.code);
    if (letterMatch) return letterMatch[1];

    const digitMatch = /^Digit([0-9])$/.exec(event.code);
    if (digitMatch) return digitMatch[1];
  }

  return event.key;
}

export function eventToAccelerator(
  event: KeybindingEventLike,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;

  const parts: string[] = [];
  const key = getEventKey(event);
  if (event.metaKey) parts.push('Cmd');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  if (key === ' ') {
    parts.push('Space');
  } else if (key === 'Escape') {
    parts.push('Escape');
  } else if (key === 'Enter') {
    parts.push('Enter');
  } else if (key === 'Tab') {
    parts.push('Tab');
  } else if (key.length === 1) {
    parts.push(key.toUpperCase());
  } else {
    parts.push(key);
  }

  return normalizeAccelerator(parts.join('+'), platform);
}
