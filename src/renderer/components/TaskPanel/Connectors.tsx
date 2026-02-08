// ============================================================================
// Connectors - Display MCP server connections with details
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import { Plug, ChevronRight, ChevronDown, CheckCircle2, AlertCircle, Loader2, Sparkles, Wrench } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';

interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount?: number;
}

interface ToolCallSummary {
  name: string;
  count: number;
  lastUsed: number;
  isMcp: boolean;
  isSkill: boolean;
  serverName?: string;
}

export const Connectors: React.FC = () => {
  const { t } = useI18n();
  const { openSettingsTab } = useAppStore();
  const messages = useSessionStore((state) => state.messages);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showToolHistory, setShowToolHistory] = useState(true);

  // 从 messages 中提取会话工具调用历史
  const toolCallHistory = useMemo(() => {
    const toolMap = new Map<string, ToolCallSummary>();

    messages.forEach((msg) => {
      if (msg.toolCalls) {
        msg.toolCalls.forEach((tc) => {
          const name = tc.name;
          // 判断是否是 MCP 工具（以 mcp__ 开头或包含服务器名称）
          const isMcp = name.startsWith('mcp__') || name.startsWith('mcp_');
          // 判断是否是 Skill
          const isSkill = name === 'skill' || name.startsWith('skill_');
          // 提取 MCP 服务器名称（如 mcp__github__xxx -> github）
          let serverName: string | undefined;
          if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 2) {
              serverName = parts[1];
            }
          }

          const existing = toolMap.get(name);
          if (existing) {
            existing.count++;
            existing.lastUsed = Math.max(existing.lastUsed, msg.timestamp);
          } else {
            toolMap.set(name, {
              name,
              count: 1,
              lastUsed: msg.timestamp,
              isMcp,
              isSkill,
              serverName,
            });
          }
        });
      }
    });

    // 按最近使用排序
    return Array.from(toolMap.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  }, [messages]);

  // 分离 MCP 工具和 Skill
  const mcpTools = toolCallHistory.filter((t) => t.isMcp);
  const skillTools = toolCallHistory.filter((t) => t.isSkill);

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
            toolCount: undefined,
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
                    className="w-full flex items-center gap-2 py-1.5 rounded hover:bg-zinc-800/50 transition-colors"
                  >
                    {getStatusIcon(server.status)}
                    <span className="flex-1 text-sm text-zinc-300 truncate">{server.name}</span>
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
          <button
            onClick={() => openSettingsTab('mcp')}
            className="text-xs text-zinc-500 hover:text-zinc-300 mt-2 transition-colors"
          >
            {t.taskPanel.viewAllConnectors}
          </button>
        </div>
      )}

      {/* Session Tool Call History */}
      {(mcpTools.length > 0 || skillTools.length > 0) && (
        <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <button
            onClick={() => setShowToolHistory(!showToolHistory)}
            className="flex items-center w-full mb-2"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Wrench className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                本次调用
              </span>
              <span className="text-[10px] text-zinc-600">
                ({mcpTools.length + skillTools.length})
              </span>
            </div>
            {showToolHistory ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            )}
          </button>

          {showToolHistory && (
            <div className="space-y-2">
              {/* MCP Tools */}
              {mcpTools.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1">
                    <Plug className="w-3 h-3 text-blue-400" />
                    <span className="text-[10px] text-zinc-500 uppercase">MCP</span>
                  </div>
                  {mcpTools.slice(0, 5).map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center gap-2 py-1 px-2 rounded bg-zinc-800/30 text-xs"
                    >
                      <span className="flex-1 text-zinc-400 truncate">
                        {tool.serverName ? `${tool.serverName}` : tool.name.replace('mcp__', '').replace('mcp_', '')}
                      </span>
                      <span className="text-zinc-600">{tool.count}x</span>
                    </div>
                  ))}
                  {mcpTools.length > 5 && (
                    <div className="text-[10px] text-zinc-600 px-2">
                      +{mcpTools.length - 5} 更多
                    </div>
                  )}
                </div>
              )}

              {/* Skills */}
              {skillTools.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1">
                    <Sparkles className="w-3 h-3 text-purple-400" />
                    <span className="text-[10px] text-zinc-500 uppercase">Skills</span>
                  </div>
                  {skillTools.slice(0, 5).map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center gap-2 py-1 px-2 rounded bg-zinc-800/30 text-xs"
                    >
                      <span className="flex-1 text-zinc-400 truncate">
                        {tool.name.replace('skill_', '')}
                      </span>
                      <span className="text-zinc-600">{tool.count}x</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
