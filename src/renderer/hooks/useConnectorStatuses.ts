import { useEffect, useState } from 'react';
import { IPC_CHANNELS, IPC_DOMAINS, type ConnectorEvent, type ConnectorStatusSummary } from '@shared/ipc';
import ipcService from '../services/ipcService';

export function useConnectorStatuses(): ConnectorStatusSummary[] {
  const [statuses, setStatuses] = useState<ConnectorStatusSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    const syncConnectors = async () => {
      try {
        const nextStatuses = await ipcService.invokeDomain<ConnectorStatusSummary[]>(IPC_DOMAINS.CONNECTOR, 'listStatuses');
        if (!cancelled) {
          setStatuses(Array.isArray(nextStatuses) ? nextStatuses : []);
        }
      } catch {
        if (!cancelled) {
          setStatuses([]);
        }
      }
    };

    void syncConnectors();
    const unsubscribe = ipcService.on(IPC_CHANNELS.CONNECTOR_EVENT, (event: ConnectorEvent) => {
      if (!cancelled) {
        setStatuses(Array.isArray(event?.data) ? event.data : []);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return statuses;
}
