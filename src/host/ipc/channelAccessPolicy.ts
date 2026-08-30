import { assertAdminAccess } from './adminGuard';
import { getAdminAccessIpcError } from './adminGuard';
import type { IPCResponse } from '../../shared/ipc';

type ChannelAccessLevel = 'admin' | 'user';

const CHANNEL_ACCESS_POLICY = new Map<string, ChannelAccessLevel>([
  ['evaluation:run-suite', 'admin'],
  ['evaluation:run-events', 'admin'],
  ['evaluation:abort-run', 'admin'],
  ['evaluation:scorers-overview', 'admin'],
  ['evaluation:list-cases', 'admin'],
  ['evaluation:save-case', 'admin'],
]);

function getChannelAccessLevel(channel: string): ChannelAccessLevel {
  return CHANNEL_ACCESS_POLICY.get(channel) ?? 'user';
}

export function isAdminChannel(channel: string): boolean {
  return getChannelAccessLevel(channel) === 'admin';
}

export function assertChannelAccess(channel: string): void {
  if (isAdminChannel(channel)) {
    assertAdminAccess(`IPC channel ${channel}`);
  }
}

export function getChannelAccessIpcError(channel: string, surface: string): IPCResponse | null {
  return isAdminChannel(channel)
    ? getAdminAccessIpcError(surface)
    : null;
}
