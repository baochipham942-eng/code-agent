// ============================================================================
// McpDiscoverTab - unconfigured MCP entries inside the unified connector grid
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Check, Link2, Loader2, Monitor, Plug, ShieldAlert } from 'lucide-react';
import type { McpCatalogPayload, RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import { getMcpRuntimeBadge, groupRecommendedMcpServersByCategory } from '@shared/constants/mcpCatalog';
import { Button, Modal } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import { ConnectorLogo } from '../../connectors/ConnectorLogo';

type McpDiscoverLabels = typeof zh.settings.mcp.discover;

export interface McpDiscoverTabProps {
  catalog: McpCatalogPayload;
  existingServerIds: Set<string>;
  enabledServerIds: Set<string>;
  canManageMcp: boolean;
  actionLoading: Set<string>;
  onAdd: (entry: RecommendedMcpServerEntry) => void;
  onEnableBuiltin: (serverId: string) => void;
  onOpenComputerUsePanel?: () => void;
}

export function getEntryAction(
  entry: RecommendedMcpServerEntry,
  existingServerIds: Set<string>,
  enabledServerIds: Set<string>,
): 'enabled' | 'enable-builtin' | 'connected' | 'add' {
  if (entry.builtin) {
    return enabledServerIds.has(entry.id) ? 'enabled' : 'enable-builtin';
  }
  if (existingServerIds.has(entry.id)) return 'connected';
  return 'add';
}

function getRuntimeBadgeLabel(
  entry: RecommendedMcpServerEntry,
  labels: McpDiscoverLabels,
): string | null {
  const badge = getMcpRuntimeBadge(entry);
  switch (badge) {
    case 'builtin': return labels.runtimeBuiltin;
    case 'remote': return labels.runtimeRemote;
    case 'npx': return 'NPX';
    case 'uvx': return 'UVX';
    default: return null;
  }
}

export const McpDiscoverTab: React.FC<McpDiscoverTabProps> = ({
  catalog,
  existingServerIds,
  enabledServerIds,
  canManageMcp,
  actionLoading,
  onAdd,
  onEnableBuiltin,
  onOpenComputerUsePanel,
}) => {
  const { t } = useI18n();
  const labels = t.settings.mcp.discover;
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const entries = useMemo(
    () => groupRecommendedMcpServersByCategory(catalog)
      .flatMap(({ servers }) => servers)
      // 飞书只读 MCP 已合并进 SaaS 飞书详情的进阶区，不能在网格重复出现。
      .filter((entry) => entry.id !== 'lark' && !existingServerIds.has(entry.id)),
    [catalog, existingServerIds],
  );
  const activeEntry = activeEntryId
    ? entries.find((entry) => entry.id === activeEntryId)
    : undefined;

  return (
    <div className="contents" data-testid="mcp-discover-grid-items">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpenComputerUsePanel}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && onOpenComputerUsePanel) onOpenComputerUsePanel();
        }}
        className="min-h-36 cursor-pointer rounded-xl border border-badge-warning/20 bg-amber-500/[0.04] p-4 transition-colors hover:border-badge-warning/40"
        data-testid="mcp-computer-use-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-badge-warning/20 bg-amber-500/10">
              <Monitor className="h-4 w-4 text-badge-warning" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{labels.computerUse.title}</span>
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-badge-danger">
                  {labels.computerUse.highPrivilegeBadge}
                </span>
              </div>
            </div>
          </div>
          <ShieldAlert className="h-4 w-4 text-badge-warning" />
        </div>
        <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-zinc-400">
          {labels.computerUse.description}
        </p>
        <div className="mt-3 text-[11px] text-zinc-500">
          {enabledServerIds.has('cua-driver')
            ? labels.computerUse.registeredEnabled
            : existingServerIds.has('cua-driver')
              ? labels.computerUse.registeredDisabled
              : labels.computerUse.unregistered}
        </div>
      </div>

      {entries.map((entry) => {
        const isLoading = actionLoading.has(entry.id);
        return (
          <div
            key={entry.id}
            role="button"
            tabIndex={0}
            onClick={() => setActiveEntryId(entry.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setActiveEntryId(entry.id);
            }}
            className="min-h-36 cursor-pointer rounded-xl border border-zinc-700 bg-zinc-900/60 p-4 text-left transition-colors hover:border-zinc-600"
            data-testid={`mcp-discover-card-${entry.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                  <ConnectorLogo
                    id={entry.logo}
                    displayName={entry.name}
                    fallback={<Plug className="h-4 w-4 text-zinc-400" />}
                  />
                </span>
                <span className="truncate text-sm font-medium text-zinc-100">{entry.name}</span>
              </div>
              <button /* ds-allow:button: 卡片右上角紧凑连接动作位 */
                type="button"
                aria-label={`${labels.grid.viewDetails} ${entry.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveEntryId(entry.id);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-600 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
              >
                {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-zinc-400">{entry.description}</p>
            <div className="mt-3 text-[11px] text-zinc-500">{labels.grid.notConnected}</div>
          </div>
        );
      })}

      <Modal
        isOpen={Boolean(activeEntry)}
        onClose={() => setActiveEntryId(null)}
        title={activeEntry?.name}
        size="md"
        portal
      >
        {activeEntry && (() => {
          const action = getEntryAction(activeEntry, existingServerIds, enabledServerIds);
          const runtimeBadgeLabel = getRuntimeBadgeLabel(activeEntry, labels);
          const isLoading = actionLoading.has(activeEntry.id);
          return (
            <div className="space-y-4 p-5" data-testid={`mcp-discover-detail-${activeEntry.id}`}>
              <div className="text-center">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800">
                  <ConnectorLogo
                    id={activeEntry.logo}
                    displayName={activeEntry.name}
                    fallback={<Plug className="h-5 w-5 text-zinc-300" />}
                    className="h-5 w-5"
                  />
                </span>
                <p className="mt-3 text-xs leading-relaxed text-zinc-400">{activeEntry.description}</p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                {runtimeBadgeLabel && (
                  <span
                    data-testid={`mcp-discover-runtime-${activeEntry.id}`}
                    className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                  >
                    {runtimeBadgeLabel}
                  </span>
                )}
                {activeEntry.chinaDirect && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-badge-success">
                    {labels.chinaDirect}
                  </span>
                )}
              </div>

              <div className="rounded-md border border-zinc-700 bg-zinc-950/40 p-3">
                <div className="text-[11px] font-medium text-zinc-400">{labels.grid.connectionSetup}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  {activeEntry.requiredCredentials?.length ? labels.grid.secretInNextStep : labels.noConfig}
                </p>
                {action === 'enabled' || action === 'connected' ? (
                  <span
                    data-testid={`mcp-discover-added-${activeEntry.id}`}
                    className="mt-3 flex items-center gap-1 text-xs text-zinc-500"
                  >
                    <Check className="h-3 w-3" />{labels.added}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    className="mt-3"
                    data-testid={action === 'add' ? `mcp-discover-add-${activeEntry.id}` : undefined}
                    onClick={() => {
                      if (action === 'enable-builtin') onEnableBuiltin(activeEntry.id);
                      else onAdd(activeEntry);
                    }}
                    loading={isLoading}
                    disabled={isWebMode() || !canManageMcp}
                  >
                    {action === 'enable-builtin' ? labels.enable : labels.add}
                  </Button>
                )}
              </div>

              <div className="border-t border-zinc-700 pt-3">
                <div className="text-[11px] font-medium text-zinc-400">{labels.grid.tryIt}</div>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-zinc-300">
                  {labels.grid.examples.map((example) => (
                    <li key={example}>{example.replace('{name}', activeEntry.name)}</li>
                  ))}
                </ul>
              </div>

              <div data-testid={`mcp-discover-tools-${activeEntry.id}`} className="border-t border-zinc-700 pt-3">
                <div className="text-[11px] font-medium text-zinc-400">
                  {activeEntry.tools?.length
                    ? `${activeEntry.tools.length}${labels.toolsCountSuffix}`
                    : labels.toolsVisibleAfterInstall}
                </div>
                {activeEntry.tools?.length ? (
                  <ul className="mt-2 space-y-1">
                    {activeEntry.tools.map((tool) => (
                      <li key={tool.name} className="text-[10px] text-zinc-500">
                        <span className="font-mono text-zinc-400">{tool.name}</span>
                        {tool.description ? ` · ${tool.description}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
};
