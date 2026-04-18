import { useCallback, useEffect, useState } from 'react';
import { IPC_CHANNELS, IPC_DOMAINS, type MCPEvent } from '@shared/ipc';
import ipcService from '../services/ipcService';

export interface MCPServerStateSummary {
  config: {
    name: string;
    type: 'stdio' | 'sse' | 'in-process';
    enabled: boolean;
  };
  status: 'lazy' | 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  toolCount: number;
  resourceCount: number;
}

export interface MCPStatusSummary {
  connectedServers: string[];
  inProcessServers?: string[];
  toolCount: number;
  resourceCount: number;
  promptCount?: number;
}

const mcpStatusReloadListeners = new Set<() => void>();

export function requestMcpStatusReload(): void {
  for (const listener of mcpStatusReloadListeners) {
    listener();
  }
}

export function useMcpStatus() {
  const [status, setStatus] = useState<MCPStatusSummary | null>(null);
  const [serverStates, setServerStates] = useState<MCPServerStateSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextStates] = await Promise.all([
        ipcService.invokeDomain<MCPStatusSummary>(IPC_DOMAINS.MCP, 'getStatus'),
        ipcService.invokeDomain<MCPServerStateSummary[]>(IPC_DOMAINS.MCP, 'getServerStates'),
      ]);

      setStatus(nextStatus || null);
      setServerStates(Array.isArray(nextStates) ? nextStates : []);
    } catch {
      setStatus(null);
      setServerStates([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      if (cancelled) return;
      await reload();
    };
    const handleReloadRequest = () => {
      void sync();
    };

    void sync();
    mcpStatusReloadListeners.add(handleReloadRequest);
    const unsubscribe = ipcService.on(IPC_CHANNELS.MCP_EVENT, (_event: MCPEvent) => {
      void sync();
    });

    return () => {
      cancelled = true;
      mcpStatusReloadListeners.delete(handleReloadRequest);
      unsubscribe?.();
    };
  }, [reload]);

  return {
    status,
    serverStates,
    isLoading,
    reload,
  };
}
