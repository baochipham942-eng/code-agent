// ============================================================================
// Connector IPC Handlers - connector:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from '../platform';
import { broadcastToRenderer } from '../platform';
import {
  IPC_CHANNELS,
  IPC_DOMAINS,
  type IPCRequest,
  type IPCResponse,
  type ConnectorStatusSummary,
  type ConnectorEvent,
} from '../../shared/ipc';
import { getConnectorRegistry } from '../connectors';

const CONNECTOR_STATUS_POLL_MS = 15_000;
let connectorStatusWatchTimer: NodeJS.Timeout | null = null;
let lastConnectorStatusSnapshot = '';

export function normalizeConnectorStatuses(statuses: ConnectorStatusSummary[]): ConnectorStatusSummary[] {
  return [...statuses]
    .map((status) => ({
      ...status,
      capabilities: [...status.capabilities].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function serializeConnectorStatuses(statuses: ConnectorStatusSummary[]): string {
  return JSON.stringify(normalizeConnectorStatuses(statuses));
}

async function handleListStatuses(): Promise<ConnectorStatusSummary[]> {
  const connectors = getConnectorRegistry().list();
  return Promise.all(connectors.map(async (connector) => {
    const status = await connector.getStatus();
    return {
      id: connector.id,
      label: connector.label,
      connected: status.connected,
      detail: status.detail,
      capabilities: status.capabilities,
    } satisfies ConnectorStatusSummary;
  }));
}

async function pollAndBroadcastConnectorStatuses(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  const statuses = await handleListStatuses();
  const nextSnapshot = serializeConnectorStatuses(statuses);
  if (nextSnapshot === lastConnectorStatusSnapshot) {
    return;
  }

  lastConnectorStatusSnapshot = nextSnapshot;
  const event: ConnectorEvent = {
    type: 'status_changed',
    data: statuses,
  };

  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CONNECTOR_EVENT, event);
    return;
  }

  broadcastToRenderer(IPC_CHANNELS.CONNECTOR_EVENT, event);
}

function ensureConnectorStatusWatcher(
  getMainWindow: () => BrowserWindow | null,
): void {
  if (connectorStatusWatchTimer) {
    return;
  }

  void pollAndBroadcastConnectorStatuses(getMainWindow).catch(() => {});
  connectorStatusWatchTimer = setInterval(() => {
    void pollAndBroadcastConnectorStatuses(getMainWindow).catch(() => {});
  }, CONNECTOR_STATUS_POLL_MS);
}

export function registerConnectorHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
): void {
  ensureConnectorStatusWatcher(getMainWindow);

  ipcMain.handle(IPC_DOMAINS.CONNECTOR, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'listStatuses':
          data = await handleListStatuses();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
