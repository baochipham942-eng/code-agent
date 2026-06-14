import { getCurrentKeybindingPlatform } from './defaults';
import { normalizeAccelerator } from './normalize';
import type { KeybindingPlatform } from './types';

export interface KeybindingEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function eventToAccelerator(
  event: KeybindingEventLike,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey) parts.push('Cmd');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  if (event.key === ' ') {
    parts.push('Space');
  } else if (event.key === 'Escape') {
    parts.push('Escape');
  } else if (event.key === 'Enter') {
    parts.push('Enter');
  } else if (event.key === 'Tab') {
    parts.push('Tab');
  } else if (event.key.length === 1) {
    parts.push(event.key.toUpperCase());
  } else {
    parts.push(event.key);
  }

  return normalizeAccelerator(parts.join('+'), platform);
}
