import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostCapabilityCleanup } from './hostCapabilityPorts';
import type { IpcMain } from '../../platform';

export type ImmediateHostContribution = () => HostCapabilityCleanup;
export type HostIpcContribution = (ipcMain: IpcMain) => HostCapabilityCleanup;

export interface HostWebSocketUpgradeContribution {
  path: string;
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  cleanup: HostCapabilityCleanup;
}

const webSocketUpgrades = new Map<string, HostWebSocketUpgradeContribution>();

export function registerImmediateHostContribution(
  contribution: ImmediateHostContribution,
): HostCapabilityCleanup {
  return contribution();
}

export function registerHostWebSocketUpgrade(
  contribution: HostWebSocketUpgradeContribution,
): HostCapabilityCleanup {
  if (webSocketUpgrades.has(contribution.path)) {
    throw new Error(`WebSocket upgrade contribution already registered: ${contribution.path}`);
  }
  webSocketUpgrades.set(contribution.path, contribution);
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    webSocketUpgrades.delete(contribution.path);
    await contribution.cleanup();
  };
}

export function attachHostWebSocketUpgradeDispatcher<T extends Server>(server: T): T {
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    webSocketUpgrades.get(pathname)?.handleUpgrade(request, socket, head);
  });
  return server;
}
