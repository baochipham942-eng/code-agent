import { CLI_CONNECTOR_DESCRIPTORS } from '../../../shared/constants/cliConnectorDescriptors';

interface CliConnectorConnectionStatus {
  connected: boolean;
  checkedAt: number;
}

const cliConnectorIds = new Set(CLI_CONNECTOR_DESCRIPTORS.map((descriptor) => descriptor.id));
const statusCache = new Map<string, CliConnectorConnectionStatus>();

export function isCliConnectorId(connectorId: string): boolean {
  return cliConnectorIds.has(connectorId);
}

export function getCachedCliConnectorConnectionStatus(
  connectorId: string,
): CliConnectorConnectionStatus | undefined {
  return statusCache.get(connectorId);
}

export function replaceCliConnectorConnectionStatusCache(
  statuses: Array<{ id: string; connected: boolean }>,
): void {
  statusCache.clear();
  const checkedAt = Date.now();
  for (const status of statuses) {
    if (isCliConnectorId(status.id)) {
      statusCache.set(status.id, { connected: status.connected, checkedAt });
    }
  }
}
