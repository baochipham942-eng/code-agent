// ============================================================================
// McpDiscoverTab - 发现连接（按用途分类的推荐 MCP Server）
// ============================================================================

import React from 'react';
import { Check, Monitor, Plug, Plus, ShieldAlert } from 'lucide-react';
import type { McpCatalogPayload, RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import {
  getAlmaFeaturedMcpServers,
  groupRecommendedMcpServersByCategory,
} from '@shared/constants/mcpCatalog';
import {
  getAlmaMcpRecommendationPolicy,
  type AlmaRecommendationPolicyTier,
} from '@shared/constants/almaRecommendationPolicy';
import { Button } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

type McpDiscoverLabels = typeof zh.settings.mcp.discover;

export interface McpDiscoverTabProps {
  /** 推荐目录（云端下发优先，内置兜底） */
  catalog: McpCatalogPayload;
  /** 当前已配置的 server ID 集合（含内置与用户添加） */
  existingServerIds: Set<string>;
  /** 已启用的 server ID 集合 */
  enabledServerIds: Set<string>;
  /** 是否允许管理 MCP 配置。普通登录用户也可以自助管理。 */
  canManageMcp: boolean;
  actionLoading: string | null;
  /** 免配置 server 一键连接 */
  onQuickConnect: (entry: RecommendedMcpServerEntry) => void;
  /** 需要凭证的 server：打开预填编辑器 */
  onConnectWithConfig: (entry: RecommendedMcpServerEntry) => void;
  /** 内置 server 启用 */
  onEnableBuiltin: (serverId: string) => void;
  /** 打开本机 Computer Use 能力面板 */
  onOpenComputerUsePanel?: () => void;
}

/** 推荐条目的连接动作类型 */
export function getEntryAction(
  entry: RecommendedMcpServerEntry,
  existingServerIds: Set<string>,
  enabledServerIds: Set<string>
): 'enabled' | 'enable-builtin' | 'connected' | 'quick-connect' | 'connect-with-config' {
  if (entry.builtin) {
    return enabledServerIds.has(entry.id) ? 'enabled' : 'enable-builtin';
  }
  if (existingServerIds.has(entry.id)) {
    return 'connected';
  }
  return entry.requiredCredentials?.length ? 'connect-with-config' : 'quick-connect';
}

interface McpServerCardProps {
  entry: RecommendedMcpServerEntry;
  action: ReturnType<typeof getEntryAction>;
  canManageMcp: boolean;
  isLoading: boolean;
  labels: McpDiscoverLabels;
  onQuickConnect: (entry: RecommendedMcpServerEntry) => void;
  onConnectWithConfig: (entry: RecommendedMcpServerEntry) => void;
  onEnableBuiltin: (serverId: string) => void;
}

function getRecommendationTierClasses(tier: AlmaRecommendationPolicyTier): string {
  switch (tier) {
    case 'default_visible':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'conditional':
      return 'bg-amber-500/15 text-amber-300';
    case 'not_default':
      return 'bg-zinc-700 text-zinc-300';
    case 'unsupported':
      return 'bg-red-500/10 text-red-300';
    default:
      return 'bg-zinc-700 text-zinc-300';
  }
}

const McpServerCard: React.FC<McpServerCardProps> = ({
  entry,
  action,
  canManageMcp,
  isLoading,
  labels,
  onQuickConnect,
  onConnectWithConfig,
  onEnableBuiltin,
}) => {
  const policy = entry.officialFeatured ? getAlmaMcpRecommendationPolicy(entry) : null;

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-3 hover:border-zinc-600 transition-colors flex flex-col gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h5 className="text-sm font-medium text-zinc-200 truncate">{entry.name}</h5>
          {entry.badge && (
            <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-400">
              {entry.badge}
            </span>
          )}
          {entry.chinaDirect && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
              {labels.chinaDirect}
            </span>
          )}
          {entry.officialFeatured && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
              {labels.officialFeatured}
            </span>
          )}
          {policy && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${getRecommendationTierClasses(policy.tier)}`}>
              {policy.label}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{entry.description}</p>
        {policy?.reason && (
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{policy.reason}</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className="text-[10px] text-zinc-500 truncate">
          {entry.requiredCredentials?.length
            ? `${labels.requiredCredentialsPrefix}${entry.requiredCredentials.join(', ')}`
            : labels.noConfig}
        </span>
        {action === 'enabled' || action === 'connected' ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-400">
            <Check className="w-3 h-3" />
            {action === 'enabled' ? labels.enabled : labels.connected}
          </span>
        ) : action === 'enable-builtin' ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onEnableBuiltin(entry.id)}
            loading={isLoading}
            disabled={isWebMode() || !canManageMcp}
            leftIcon={!isLoading ? <Plug className="w-3 h-3" /> : undefined}
          >
            {labels.enable}
          </Button>
        ) : action === 'quick-connect' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onQuickConnect(entry)}
            loading={isLoading}
            disabled={isWebMode() || !canManageMcp}
            leftIcon={!isLoading ? <Plus className="w-3 h-3" /> : undefined}
          >
            {labels.quickConnect}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onConnectWithConfig(entry)}
            loading={isLoading}
            disabled={isWebMode() || !canManageMcp}
            leftIcon={!isLoading ? <Plus className="w-3 h-3" /> : undefined}
          >
            {labels.connect}
          </Button>
        )}
      </div>
    </div>
  );
};

interface ComputerUseCardProps {
  existing: boolean;
  enabled: boolean;
  canManageMcp: boolean;
  labels: McpDiscoverLabels['computerUse'];
  onOpenComputerUsePanel?: () => void;
}

const ComputerUseCard: React.FC<ComputerUseCardProps> = ({
  existing,
  enabled,
  canManageMcp,
  labels,
  onOpenComputerUsePanel,
}) => (
  <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10">
        <Monitor className="h-4 w-4 text-amber-300" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h5 className="text-sm font-medium text-zinc-100">{labels.title}</h5>
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
            {labels.almaBadge}
          </span>
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
            {labels.highPrivilegeBadge}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          {labels.description}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <ShieldAlert className="h-3 w-3 text-amber-300" />
            {labels.defaultVisible}
          </span>
          <span>{existing ? (enabled ? labels.registeredEnabled : labels.registeredDisabled) : labels.unregistered}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="self-start whitespace-nowrap"
        disabled={!canManageMcp || !onOpenComputerUsePanel}
        onClick={onOpenComputerUsePanel}
      >
        {labels.openButton}
      </Button>
    </div>
  </div>
);

export const McpDiscoverTab: React.FC<McpDiscoverTabProps> = ({
  catalog,
  existingServerIds,
  enabledServerIds,
  canManageMcp,
  actionLoading,
  onQuickConnect,
  onConnectWithConfig,
  onEnableBuiltin,
  onOpenComputerUsePanel,
}) => {
  const { t } = useI18n();
  const discoverText = t.settings.mcp.discover;
  const featuredServers = getAlmaFeaturedMcpServers(catalog);
  const featuredServerIds = new Set(featuredServers.map((server) => server.id));
  const categoryGroups = groupRecommendedMcpServersByCategory({
    ...catalog,
    servers: catalog.servers.filter((server) => !featuredServerIds.has(server.id)),
  });

  return (
    <div className="space-y-4">
      <ComputerUseCard
        existing={existingServerIds.has('cua-driver')}
        enabled={enabledServerIds.has('cua-driver')}
        canManageMcp={canManageMcp}
        labels={discoverText.computerUse}
        onOpenComputerUsePanel={onOpenComputerUsePanel}
      />

      {featuredServers.length > 0 && (
        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-medium text-zinc-200">{discoverText.featuredTitle}</h4>
            <p className="text-xs text-zinc-500 mt-0.5">
              {discoverText.featuredDescription}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {featuredServers.map((entry) => (
              <McpServerCard
                key={entry.id}
                entry={entry}
                action={getEntryAction(entry, existingServerIds, enabledServerIds)}
                canManageMcp={canManageMcp}
                isLoading={actionLoading === entry.id}
                labels={discoverText}
                onQuickConnect={onQuickConnect}
                onConnectWithConfig={onConnectWithConfig}
                onEnableBuiltin={onEnableBuiltin}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-sm font-medium text-zinc-200">{discoverText.browseTitle}</h4>
        <p className="text-xs text-zinc-500 mt-0.5">
          {discoverText.browseDescription}
        </p>
      </div>
      {categoryGroups.map(({ category, servers }) => (
        <div key={category.id} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h5 className="text-xs font-medium text-zinc-300">{category.label}</h5>
            <span className="text-[10px] text-zinc-500">{category.description}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {servers.map((entry) => (
              <McpServerCard
                key={entry.id}
                entry={entry}
                action={getEntryAction(entry, existingServerIds, enabledServerIds)}
                canManageMcp={canManageMcp}
                isLoading={actionLoading === entry.id}
                labels={discoverText}
                onQuickConnect={onQuickConnect}
                onConnectWithConfig={onConnectWithConfig}
                onEnableBuiltin={onEnableBuiltin}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
