import { assertAdminAccess } from './adminGuard';
import { getAdminAccessIpcError } from './adminGuard';
import type { IPCResponse } from '../../shared/ipc';

const ADMIN_CHANNELS = new Set<string>();

/** Internal packages register their private transport channels only while installed. */
export function registerAdminChannels(channels: readonly string[]): () => void {
  channels.forEach((channel) => ADMIN_CHANNELS.add(channel));
  return () => channels.forEach((channel) => ADMIN_CHANNELS.delete(channel));
}

export function isAdminChannel(channel: string): boolean {
  return ADMIN_CHANNELS.has(channel);
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
