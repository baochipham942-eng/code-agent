import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import type { IPCResponse } from '../../../shared/ipc';
import type { HostCapabilityCleanup } from './hostCapabilityPorts';
import type { IpcMain } from '../../platform';

export type ImmediateHostContribution = () => HostCapabilityCleanup;
export type HostIpcContribution = (ipcMain: IpcMain) => HostCapabilityCleanup;

export interface HostWebRouteContribution {
  path: string;
  handler: RequestHandler;
}

export interface HostProviderActionContribution {
  actions: readonly string[];
  handle: (action: string, payload: unknown) => Promise<IPCResponse>;
}

export interface HostWebSocketUpgradeContribution {
  path: string;
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  cleanup: HostCapabilityCleanup;
}

const webSocketUpgrades = new Map<string, HostWebSocketUpgradeContribution>();
const webRoutes = new Map<string, HostWebRouteContribution>();
const providerActions = new Map<string, HostProviderActionContribution>();

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

export function registerHostWebRoute(
  contribution: HostWebRouteContribution,
): HostCapabilityCleanup {
  if (webRoutes.has(contribution.path)) {
    throw new Error(`Web route contribution already registered: ${contribution.path}`);
  }
  webRoutes.set(contribution.path, contribution);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    webRoutes.delete(contribution.path);
  };
}

export const dispatchHostWebRoute: RequestHandler = (request, response, next) => {
  const contribution = [...webRoutes.values()]
    .find((candidate) => request.path === candidate.path || request.path.startsWith(`${candidate.path}/`));
  if (!contribution) {
    next();
    return;
  }
  contribution.handler(request, response, next);
};

export function registerHostProviderAction(
  contribution: HostProviderActionContribution,
): HostCapabilityCleanup {
  for (const action of contribution.actions) {
    if (providerActions.has(action)) {
      throw new Error(`Provider action contribution already registered: ${action}`);
    }
  }
  for (const action of contribution.actions) providerActions.set(action, contribution);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const action of contribution.actions) {
      if (providerActions.get(action) === contribution) providerActions.delete(action);
    }
  };
}

export async function dispatchHostProviderAction(
  action: string,
  payload: unknown,
): Promise<IPCResponse | null> {
  const contribution = providerActions.get(action);
  return contribution ? contribution.handle(action, payload) : null;
}

export function attachHostWebSocketUpgradeDispatcher<T extends Server>(server: T): T {
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    webSocketUpgrades.get(pathname)?.handleUpgrade(request, socket, head);
  });
  return server;
}
