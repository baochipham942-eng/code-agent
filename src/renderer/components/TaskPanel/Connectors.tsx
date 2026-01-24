// ============================================================================
// Connectors - Display MCP server connections
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Plug, ChevronRight, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';

interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount?: number;
}

export const Connectors: React.FC = () => {
  const [servers, setServers] = useState<McpServer[]>([]);

  // Fetch MCP server status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await window.electronAPI?.invoke(IPC_CHANNELS.MCP_GET_STATUS);
        if (status && status.connectedServers) {
          // Transform connectedServers array to McpServer format
          setServers(status.connectedServers.map((name: string) => ({
            name,
            status: 'connected' as const,
            toolCount: Math.floor(status.toolCount / status.connectedServers.length) || 0,
          })));
        }
      } catch (error) {
        // Silently fail - MCP might not be available
      }
    };

    fetchStatus();

    // Listen for MCP events
    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.MCP_EVENT,
      () => {
        fetchStatus();
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  const getStatusIcon = (status: McpServer['status']) => {
    switch (status) {
      case 'connected':
        return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />;
      case 'connecting':
        return <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />;
      case 'error':
        return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
      default:
        return <div className="w-3.5 h-3.5 rounded-full bg-zinc-600" />;
    }
  };

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <Plug className="w-4 h-4 text-primary-400" />
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
          Connectors
        </span>
      </div>

      <div className="space-y-1">
        {servers.length > 0 ? (
          servers.map((server) => (
            <div
              key={server.name}
              className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                {getStatusIcon(server.status)}
                <span className="text-sm text-zinc-300">{server.name}</span>
              </div>
              {server.toolCount !== undefined && server.toolCount > 0 && (
                <span className="text-xs text-zinc-500">{server.toolCount} tools</span>
              )}
            </div>
          ))
        ) : (
          <div className="text-xs text-zinc-600 py-2">No connectors configured</div>
        )}

        {/* View all link */}
        <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mt-2 transition-colors">
          <span>View all connectors</span>
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};
