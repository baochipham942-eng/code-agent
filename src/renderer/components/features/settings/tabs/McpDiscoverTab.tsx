// ============================================================================
// McpDiscoverTab - 发现连接（按用途分类的推荐 MCP Server 货架卡）
// 卡片语言与技能/专家页货架卡一致（SHELF_CARD 同底同距）：左侧展开箭头 +
// 图标瓦片 + 名称 + 运行时徽标（NPX/UVX/远程/内置，从目录既有字段推导），
// 下方一句描述，右侧单一「添加」主按钮（统一打开预填配置的 McpServerEditor）。
// 展开层显示静态策展工具清单（名录抄自官方 README）；没填清单的显示占位。
// ============================================================================

import React, { useState } from 'react';
import { Check, ChevronRight, Monitor, Plug, Plus, ShieldAlert } from 'lucide-react';
import type { McpCatalogPayload, RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import { getMcpRuntimeBadge, groupRecommendedMcpServersByCategory } from '@shared/constants/mcpCatalog';
import { Button } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

type McpDiscoverLabels = typeof zh.settings.mcp.discover;

/** 货架卡统一容器：与专家/技能页 SHELF_CARD 同语言（zinc 底，紫底渐变已退役） */
const SHELF_CARD_CLASS = 'flex flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5';

export interface McpDiscoverTabProps {
  /** 推荐目录（云端下发优先，内置兜底） */
  catalog: McpCatalogPayload;
  /** 当前已配置的 server ID 集合（含内置与用户添加） */
  existingServerIds: Set<string>;
  /** 已启用的 server ID 集合 */
  enabledServerIds: Set<string>;
  /** 是否允许管理 MCP 配置。普通登录用户也可以自助管理。 */
  canManageMcp: boolean;
  /** 正在安装/启用中的 entry id 集合（每个 entry 独立 loading，见 A5 stale-promise 修复） */
  actionLoading: Set<string>;
  /** 添加 server：打开预填好目录配置的 McpServerEditor（连接逻辑不变） */
  onAdd: (entry: RecommendedMcpServerEntry) => void;
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
): 'enabled' | 'enable-builtin' | 'connected' | 'add' {
  if (entry.builtin) {
    return enabledServerIds.has(entry.id) ? 'enabled' : 'enable-builtin';
  }
  if (existingServerIds.has(entry.id)) {
    return 'connected';
  }
  return 'add';
}

/** 运行时徽标文案：npx/uvx 用字面量，builtin/remote 走 i18n */
function getRuntimeBadgeLabel(
  entry: RecommendedMcpServerEntry,
  labels: McpDiscoverLabels
): string | null {
  const badge = getMcpRuntimeBadge(entry);
  switch (badge) {
    case 'builtin':
      return labels.runtimeBuiltin;
    case 'remote':
      return labels.runtimeRemote;
    case 'npx':
      return 'NPX';
    case 'uvx':
      return 'UVX';
    default:
      return null;
  }
}

interface McpServerCardProps {
  entry: RecommendedMcpServerEntry;
  action: ReturnType<typeof getEntryAction>;
  canManageMcp: boolean;
  isLoading: boolean;
  labels: McpDiscoverLabels;
  onAdd: (entry: RecommendedMcpServerEntry) => void;
  onEnableBuiltin: (serverId: string) => void;
}

const McpServerCard: React.FC<McpServerCardProps> = ({
  entry,
  action,
  canManageMcp,
  isLoading,
  labels,
  onAdd,
  onEnableBuiltin,
}) => {
  const [expanded, setExpanded] = useState(false);
  const runtimeBadgeLabel = getRuntimeBadgeLabel(entry, labels);

  return (
    <div data-testid={`mcp-discover-card-${entry.id}`} className={SHELF_CARD_CLASS}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid={`mcp-discover-expand-${entry.id}`}
          aria-expanded={expanded}
          aria-label={expanded ? labels.collapseTools : labels.expandTools}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-800/70">
          <Plug className="h-4 w-4 text-zinc-400" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="truncate text-sm font-medium text-zinc-200">{entry.name}</h5>
            {runtimeBadgeLabel && (
              <span
                data-testid={`mcp-discover-runtime-${entry.id}`}
                className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              >
                {runtimeBadgeLabel}
              </span>
            )}
            {entry.chinaDirect && (
              <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
                {labels.chinaDirect}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{entry.description}</p>
          <p className="mt-1 text-[10px] text-zinc-500">
            {entry.requiredCredentials?.length
              ? `${labels.requiredCredentialsPrefix}${entry.requiredCredentials.join(', ')}`
              : labels.noConfig}
          </p>
        </div>
        {action === 'enabled' || action === 'connected' ? (
          <span
            data-testid={`mcp-discover-added-${entry.id}`}
            className="flex shrink-0 items-center gap-1 text-xs text-zinc-500"
          >
            <Check className="w-3 h-3" />
            {labels.added}
          </span>
        ) : action === 'enable-builtin' ? (
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => onEnableBuiltin(entry.id)}
            loading={isLoading}
            disabled={isWebMode() || !canManageMcp}
            leftIcon={!isLoading ? <Plug className="w-3 h-3" /> : undefined}
          >
            {labels.enable}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            className="shrink-0"
            data-testid={`mcp-discover-add-${entry.id}`}
            onClick={() => onAdd(entry)}
            loading={isLoading}
            disabled={isWebMode() || !canManageMcp}
            leftIcon={!isLoading ? <Plus className="w-3 h-3" /> : undefined}
          >
            {labels.add}
          </Button>
        )}
      </div>
      {expanded && (
        <div
          data-testid={`mcp-discover-tools-${entry.id}`}
          className="ml-8 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          {entry.tools?.length ? (
            <>
              <div className="text-[11px] font-medium text-zinc-400">
                {entry.tools.length}{labels.toolsCountSuffix}
              </div>
              <ul className="mt-1.5 space-y-1">
                {entry.tools.map((tool) => (
                  <li key={tool.name} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-[11px] text-zinc-300">{tool.name}</span>
                    {tool.description ? (
                      <span className="text-[10px] text-zinc-500">{tool.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="text-[11px] text-zinc-500">{labels.toolsVisibleAfterInstall}</div>
          )}
        </div>
      )}
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
  onAdd,
  onEnableBuiltin,
  onOpenComputerUsePanel,
}) => {
  const { t } = useI18n();
  const discoverText = t.settings.mcp.discover;
  const categoryGroups = groupRecommendedMcpServersByCategory(catalog);

  return (
    <div className="space-y-4">
      <ComputerUseCard
        existing={existingServerIds.has('cua-driver')}
        enabled={enabledServerIds.has('cua-driver')}
        canManageMcp={canManageMcp}
        labels={discoverText.computerUse}
        onOpenComputerUsePanel={onOpenComputerUsePanel}
      />

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
          <div className="flex flex-col gap-2">
            {servers.map((entry) => (
              <McpServerCard
                key={entry.id}
                entry={entry}
                action={getEntryAction(entry, existingServerIds, enabledServerIds)}
                canManageMcp={canManageMcp}
                isLoading={actionLoading.has(entry.id)}
                labels={discoverText}
                onAdd={onAdd}
                onEnableBuiltin={onEnableBuiltin}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
