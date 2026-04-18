// ============================================================================
// Connectors - Display MCP server connections with details
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { Plug, ChevronRight, ChevronDown, CheckCircle2, AlertCircle, Loader2, Sparkles, Wrench, Settings } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useWorkbenchInsights } from '../../hooks/useWorkbenchInsights';
import { useWorkbenchCapabilityRegistry } from '../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchCapabilityQuickActionRunner } from '../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useAppStore } from '../../stores/appStore';
import { WorkbenchCapabilityDetailButton, WorkbenchHistoryRow, WorkbenchPill, WorkbenchSectionLabel } from './WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../workbench/WorkbenchCapabilitySheetLite';
import {
  getWorkbenchCapabilityStatusPresentation,
  getWorkbenchCapabilityTitle,
  formatWorkbenchHistoryActionSummary,
} from '../../utils/workbenchPresentation';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../utils/workbenchCapabilitySheet';

export const Connectors: React.FC = () => {
  const { t } = useI18n();
  const { openSettingsTab } = useAppStore();
  const { connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const {
    history,
    connectorHistory,
    mcpHistory,
    skillHistory,
  } = useWorkbenchInsights();
  const [expanded, setExpanded] = useState(true);
  const [expandedConnectors, setExpandedConnectors] = useState<Set<string>>(new Set());
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showToolHistory, setShowToolHistory] = useState(true);
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  const hasAnyConnectorStatus = connectors.length > 0 || mcpServers.length > 0;
  const registryItems = useMemo(() => [...connectors, ...mcpServers], [connectors, mcpServers]);
  const activeSheetCapability = useMemo(
    () => resolveWorkbenchCapabilityFromSources({
      target: activeSheetTarget,
      primaryItems: registryItems,
    }),
    [activeSheetTarget, registryItems],
  );
  const activeSheetHistory = useMemo(
    () => activeSheetTarget ? findWorkbenchCapabilityHistoryItem(history, activeSheetTarget) : null,
    [activeSheetTarget, history],
  );

  const getStatusIcon = (
    status: 'connected' | 'disconnected' | 'connecting' | 'error' | 'lazy' | 'not_applicable',
  ) => {
    switch (status) {
      case 'connected':
        return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />;
      case 'connecting':
        return <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />;
      case 'lazy':
        return <div className="w-3.5 h-3.5 rounded-full bg-sky-500/80" />;
      case 'error':
        return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
      case 'disconnected':
        return <div className="w-3.5 h-3.5 rounded-full bg-zinc-600" />;
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

  const toggleConnectorExpand = (connectorId: string) => {
    setExpandedConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(connectorId)) {
        next.delete(connectorId);
      } else {
        next.add(connectorId);
      }
      return next;
    });
  };

  const openCapabilitySheet = useCallback((target: WorkbenchCapabilityTarget) => {
    setActiveSheetTarget(target);
  }, []);

  return (
    <>
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
          <div className="space-y-2 mt-3">
            {connectors.length > 0 && (
              <div className="space-y-1.5">
                <WorkbenchSectionLabel icon={<Plug className="w-3 h-3 text-sky-400" />} label="Local" />
                {connectors.map((connector) => {
                  const isExpanded = expandedConnectors.has(connector.id);
                  const connectorStatus = getWorkbenchCapabilityStatusPresentation(connector, { locale: 'en' });
                  return (
                    <div key={connector.id} className="rounded overflow-hidden">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleConnectorExpand(connector.id)}
                          className="flex-1 flex items-center gap-2 py-1 px-2 bg-zinc-800 rounded hover:bg-zinc-800 transition-colors"
                          title={getWorkbenchCapabilityTitle(connector, { locale: 'zh' })}
                        >
                          {getStatusIcon(connector.lifecycle.connectionState)}
                          <span className="flex-1 text-sm text-zinc-400 truncate">{connector.label}</span>
                          <span className={`text-xs ${connectorStatus.colorClass}`}>{connectorStatus.label}</span>
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                          )}
                        </button>
                        <WorkbenchCapabilityDetailButton
                          label={connector.label}
                          onClick={() => openCapabilitySheet({
                            kind: connector.kind,
                            id: connector.id,
                          })}
                        />
                      </div>

                      {isExpanded && (
                        <div className="px-2 py-2 bg-zinc-900 text-xs space-y-1">
                          <div className="flex justify-between text-zinc-400">
                            <span>{t.taskPanel.status}:</span>
                            <span className={connectorStatus.colorClass}>
                              {connectorStatus.label}
                            </span>
                          </div>
                          {connector.detail && (
                            <div className="text-zinc-500 leading-relaxed">
                              {connector.detail}
                            </div>
                          )}
                          {connector.capabilities.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {connector.capabilities.slice(0, 4).map((capability) => (
                                <WorkbenchPill
                                  key={capability}
                                  tone="neutral"
                                  className="bg-white/[0.03] text-zinc-500"
                                >
                                  {capability}
                                </WorkbenchPill>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {mcpServers.length > 0 && (
              <div className="space-y-1.5">
                <WorkbenchSectionLabel icon={<Plug className="w-3 h-3 text-blue-400" />} label="MCP" />
                {mcpServers.map((server) => {
                  const isServerExpanded = expandedServers.has(server.id);
                  const serverStatus = getWorkbenchCapabilityStatusPresentation(server, { locale: 'en' });

                  return (
                    <div key={server.id} className="rounded overflow-hidden">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleServerExpand(server.id)}
                          className="flex-1 flex items-center gap-2 py-1 px-2 bg-zinc-800 rounded hover:bg-zinc-800 transition-colors"
                          title={getWorkbenchCapabilityTitle(server, { locale: 'zh' })}
                        >
                          {getStatusIcon(server.lifecycle.connectionState)}
                          <span className="flex-1 text-sm text-zinc-400 truncate">{server.label}</span>
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
                        <WorkbenchCapabilityDetailButton
                          label={server.label}
                          onClick={() => openCapabilitySheet({
                            kind: server.kind,
                            id: server.id,
                          })}
                        />
                      </div>

                      {isServerExpanded && (
                        <div className="px-2 py-2 bg-zinc-900 text-xs space-y-1">
                          <div className="flex justify-between text-zinc-400">
                            <span>{t.taskPanel.status}:</span>
                            <span className={serverStatus.colorClass}>
                              {serverStatus.label}
                            </span>
                          </div>
                          {server.toolCount !== undefined && (
                            <div className="flex justify-between text-zinc-400">
                              <span>{t.taskPanel.toolCount}:</span>
                              <span>{server.toolCount}</span>
                            </div>
                          )}
                          {server.resourceCount !== undefined && (
                            <div className="flex justify-between text-zinc-400">
                              <span>resources:</span>
                              <span>{server.resourceCount}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-zinc-400">
                            <span>transport:</span>
                            <span>{server.transport}</span>
                          </div>
                          {server.error && (
                            <div className="text-zinc-500 leading-relaxed">
                              {server.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!hasAnyConnectorStatus && (
              <div className="text-xs text-zinc-500 py-1">{t.taskPanel.noConnectors}</div>
            )}

            <button
              onClick={() => openSettingsTab('mcp')}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors pt-1"
            >
              <Settings className="w-3 h-3" />
              <span>{t.taskPanel.viewAllConnectors}</span>
            </button>
          </div>
        )}

        {(connectorHistory.length > 0 || mcpHistory.length > 0 || skillHistory.length > 0) && (
          <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <button
            onClick={() => setShowToolHistory(!showToolHistory)}
            className="flex items-center w-full mb-2"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Wrench className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                {t.taskPanel.sessionCalls}
              </span>
              <span className="text-[10px] text-zinc-600">
                ({connectorHistory.length + mcpHistory.length + skillHistory.length})
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
              {/* Connector Tools */}
              {connectorHistory.length > 0 && (
                <div className="space-y-1.5">
                  <WorkbenchSectionLabel icon={<Plug className="w-3 h-3 text-sky-400" />} label="Connectors" />
                  {connectorHistory.slice(0, 5).map((item) => (
                    <WorkbenchHistoryRow
                      key={`${item.kind}-${item.id}`}
                      item={item}
                      summary={formatWorkbenchHistoryActionSummary(item.topActions)}
                    />
                  ))}
                  {connectorHistory.length > 5 && (
                    <div className="text-[10px] text-zinc-600 px-2">
                      +{connectorHistory.length - 5} {t.taskPanel.more}
                    </div>
                  )}
                </div>
              )}

              {/* MCP Tools */}
              {mcpHistory.length > 0 && (
                <div className="space-y-1.5">
                  <WorkbenchSectionLabel icon={<Plug className="w-3 h-3 text-blue-400" />} label="MCP" />
                  {mcpHistory.slice(0, 5).map((item) => (
                    <WorkbenchHistoryRow
                      key={`${item.kind}-${item.id}`}
                      item={item}
                      summary={formatWorkbenchHistoryActionSummary(item.topActions)}
                    />
                  ))}
                  {mcpHistory.length > 5 && (
                    <div className="text-[10px] text-zinc-600 px-2">
                      +{mcpHistory.length - 5} {t.taskPanel.more}
                    </div>
                  )}
                </div>
              )}

              {/* Skills */}
              {skillHistory.length > 0 && (
                <div className="space-y-1">
                  <WorkbenchSectionLabel icon={<Sparkles className="w-3 h-3 text-purple-400" />} label="Skills" />
                  {skillHistory.slice(0, 5).map((item) => (
                    <WorkbenchHistoryRow
                      key={`${item.kind}-${item.id}`}
                      item={item}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          </div>
        )}
      </div>

      <WorkbenchCapabilitySheetLite
        isOpen={Boolean(activeSheetCapability)}
        capability={activeSheetCapability}
        historyItem={activeSheetHistory}
        runningActionKey={runningActionKey}
        actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
        completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
        onQuickAction={runQuickAction}
        onClose={() => setActiveSheetTarget(null)}
      />
    </>
  );
};
