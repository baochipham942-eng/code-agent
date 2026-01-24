// ============================================================================
// Connectors - Display MCP server connections with details
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Plug, ChevronRight, ChevronDown, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';

interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount?: number;
}

export const Connectors: React.FC = () => {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

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

  const toggleServerExpand = (name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Plug className="w-4 h-4 text-primary-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.connectors}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1 mt-3">
          {servers.length > 0 ? (
            servers.map((server) => {
              const isServerExpanded = expandedServers.has(server.name);

              return (
                <div key={server.name} className="rounded overflow-hidden">
                  <button
                    onClick={() => toggleServerExpand(server.name)}
                    className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {getStatusIcon(server.status)}
                      <span className="text-sm text-zinc-300">{server.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {server.toolCount !== undefined && server.toolCount > 0 && (
                        <span className="text-xs text-zinc-500">
                          {server.toolCount} {t.taskPanel.tools}
                        </span>
                      )}
                      {isServerExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                      )}
                    </div>
                  </button>

                  {/* Expanded server details */}
                  {isServerExpanded && (
                    <div className="px-2 py-2 bg-zinc-900/50 text-xs space-y-1">
                      <div className="flex justify-between text-zinc-400">
                        <span>Status:</span>
                        <span className={
                          server.status === 'connected' ? 'text-green-400' :
                          server.status === 'error' ? 'text-red-400' :
                          'text-amber-400'
                        }>
                          {server.status}
                        </span>
                      </div>
                      {server.toolCount !== undefined && (
                        <div className="flex justify-between text-zinc-400">
                          <span>Tools:</span>
                          <span>{server.toolCount}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-xs text-zinc-600 py-2">{t.taskPanel.noConnectors}</div>
          )}

          {/* View all link */}
          <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mt-2 transition-colors">
            <span>{t.taskPanel.viewAllConnectors}</span>
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
};
