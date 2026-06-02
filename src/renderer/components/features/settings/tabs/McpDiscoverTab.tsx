// ============================================================================
// McpDiscoverTab - 发现连接（按用途分类的推荐 MCP Server）
// ============================================================================

import React from 'react';
import { Check, Plug, Plus } from 'lucide-react';
import type { RecommendedMcpServerEntry } from '@shared/contract/mcpCatalog';
import { groupRecommendedMcpServersByCategory } from '@shared/constants/mcpCatalog';
import { Button } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';

export interface McpDiscoverTabProps {
  /** 当前已配置的 server ID 集合（含内置与用户添加） */
  existingServerIds: Set<string>;
  /** 已启用的 server ID 集合 */
  enabledServerIds: Set<string>;
  /** 是否管理员（非管理员只读） */
  isAdmin: boolean;
  actionLoading: string | null;
  /** 免配置 server 一键连接 */
  onQuickConnect: (entry: RecommendedMcpServerEntry) => void;
  /** 需要凭证的 server：打开预填编辑器 */
  onConnectWithConfig: (entry: RecommendedMcpServerEntry) => void;
  /** 内置 server 启用 */
  onEnableBuiltin: (serverId: string) => void;
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
  isAdmin: boolean;
  isLoading: boolean;
  onQuickConnect: (entry: RecommendedMcpServerEntry) => void;
  onConnectWithConfig: (entry: RecommendedMcpServerEntry) => void;
  onEnableBuiltin: (serverId: string) => void;
}

const McpServerCard: React.FC<McpServerCardProps> = ({
  entry,
  action,
  isAdmin,
  isLoading,
  onQuickConnect,
  onConnectWithConfig,
  onEnableBuiltin,
}) => (
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
            国内直连
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{entry.description}</p>
    </div>
    <div className="flex items-center justify-between gap-2 mt-auto">
      <span className="text-[10px] text-zinc-500 truncate">
        {entry.requiredCredentials?.length
          ? `需要: ${entry.requiredCredentials.join(', ')}`
          : '免配置'}
      </span>
      {action === 'enabled' || action === 'connected' ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-400">
          <Check className="w-3 h-3" />
          {action === 'enabled' ? '已启用' : '已连接'}
        </span>
      ) : action === 'enable-builtin' ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onEnableBuiltin(entry.id)}
          loading={isLoading}
          disabled={isWebMode() || !isAdmin}
          leftIcon={!isLoading ? <Plug className="w-3 h-3" /> : undefined}
        >
          启用
        </Button>
      ) : action === 'quick-connect' ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => onQuickConnect(entry)}
          loading={isLoading}
          disabled={isWebMode() || !isAdmin}
          leftIcon={!isLoading ? <Plus className="w-3 h-3" /> : undefined}
        >
          一键连接
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onConnectWithConfig(entry)}
          loading={isLoading}
          disabled={isWebMode() || !isAdmin}
          leftIcon={!isLoading ? <Plus className="w-3 h-3" /> : undefined}
        >
          连接
        </Button>
      )}
    </div>
  </div>
);

export const McpDiscoverTab: React.FC<McpDiscoverTabProps> = ({
  existingServerIds,
  enabledServerIds,
  isAdmin,
  actionLoading,
  onQuickConnect,
  onConnectWithConfig,
  onEnableBuiltin,
}) => {
  const categoryGroups = groupRecommendedMcpServersByCategory();

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-zinc-200">按用途浏览</h4>
        <p className="text-xs text-zinc-500 mt-0.5">
          热门 MCP 连接，按要连的能力分类。免配置的可一键连接，需要凭证的会打开配置面板。
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
                isAdmin={isAdmin}
                isLoading={actionLoading === entry.id}
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
