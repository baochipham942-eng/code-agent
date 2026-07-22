// ============================================================================
// RolesTab - 持久化角色资产面板（设计 §7 最小版）
// 角色列表（名字/记忆条数/最近工作）→ 角色详情（定义只读 / 记忆可删可编辑 / 履历）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Brain, History, RefreshCw, UserPlus } from 'lucide-react';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { SkillCategory } from '@shared/contract/skillRepository';
import { SKILL_CATEGORIES } from '@shared/constants/skillCatalog';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { RoleIcon } from '../../shared/RoleIcon';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { RoleDetailPage } from '../../expert/RoleDetailPage';

// ----------------------------------------------------------------------------
// 角色分类分组（P2-1：复用 7 类 SkillCategory，未分类归入"其他"）
// ----------------------------------------------------------------------------

const UNCATEGORIZED_KEY = '__uncategorized__';

export interface RoleCategoryGroup {
  /** 分类 key：SkillCategory 或 UNCATEGORIZED_KEY */
  key: string;
  /** 分组显示名 */
  label: string;
  entries: RolePanelEntry[];
}

export interface RoleCategoryLabels {
  categories: Record<SkillCategory, string>;
  uncategorized: string;
}

/** 取分类显示名；未知 category 返回 undefined */
function categoryLabel(category: SkillCategory, labels: RoleCategoryLabels): string | undefined {
  return labels.categories[category];
}

/**
 * 按产物分类对角色分组（纯函数，供 UI + 单测）。
 * - 顺序跟随 SKILL_CATEGORIES，空分类不出现
 * - 无 category（用户自建角色）统一归入末尾"其他"组
 */
export function groupRolesByCategory(entries: RolePanelEntry[], labels: RoleCategoryLabels): RoleCategoryGroup[] {
  const groups: RoleCategoryGroup[] = [];
  for (const meta of SKILL_CATEGORIES) {
    const inCategory = entries.filter((e) => e.category === meta.id);
    if (inCategory.length > 0) {
      groups.push({ key: meta.id, label: labels.categories[meta.id], entries: inCategory });
    }
  }
  const uncategorized = entries.filter((e) => !e.category || !categoryLabel(e.category, labels));
  if (uncategorized.length > 0) {
    groups.push({ key: UNCATEGORIZED_KEY, label: labels.uncategorized, entries: uncategorized });
  }
  return groups;
}

const logger = createLogger('RolesTab');

// ----------------------------------------------------------------------------
// IPC helpers
// ----------------------------------------------------------------------------

async function fetchRoleList(): Promise<RolePanelEntry[]> {
  return ipcService.invokeDomain<RolePanelEntry[]>(IPC_DOMAINS.ROLES, 'list');
}

// ----------------------------------------------------------------------------
// 角色列表
// ----------------------------------------------------------------------------

interface RoleCardProps {
  entry: RolePanelEntry;
  onClick: () => void;
  labels: {
    source: {
      builtin: string;
      user: string;
      project: string;
      missing: string;
    };
    memoryCountOneSuffix: string;
    memoryCountOtherSuffix: string;
    noWork: string;
  };
}

function formatRoleMemoryCount(
  count: number,
  labels: Pick<RoleCardProps['labels'], 'memoryCountOneSuffix' | 'memoryCountOtherSuffix'>,
): string {
  return `${count}${count === 1 ? labels.memoryCountOneSuffix : labels.memoryCountOtherSuffix}`;
}

const RoleCard: React.FC<RoleCardProps> = ({ entry, onClick, labels }) => {
  const sourceLabel =
    entry.source === 'builtin'
      ? labels.source.builtin
      : entry.source === 'user'
        ? labels.source.user
        : entry.source === 'project'
          ? labels.source.project
          : null;

  return (
    <button /* ds-allow:button: 角色卡片，全宽左对齐多行内容卡，primitive 居中变体不兼容 */
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-zinc-700/70 bg-zinc-900/50 p-4 text-left transition-colors hover:border-zinc-500 hover:bg-zinc-800/60"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
          <RoleIcon name={entry.icon} className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">{entry.roleId}</span>
            {sourceLabel ? (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {sourceLabel}
              </span>
            ) : (
              <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-400">
                {labels.source.missing}
              </span>
            )}
          </div>
          {entry.description ? (
            <p className="mt-0.5 truncate text-xs text-zinc-500">{entry.description}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <Brain className="h-3 w-3" />
          {formatRoleMemoryCount(entry.memoryCount, labels)}
        </span>
        {entry.lastWork ? (
          <span className="flex min-w-0 items-center gap-1">
            <History className="h-3 w-3 shrink-0" />
            <span className="truncate">{entry.lastWork.replace(/^- /, '')}</span>
          </span>
        ) : (
          <span className="text-zinc-600">{labels.noWork}</span>
        )}
      </div>
    </button>
  );
};

// ----------------------------------------------------------------------------
// 主组件
// ----------------------------------------------------------------------------

export const RolesTab: React.FC = () => {
  const { t } = useI18n();
  const roleText = t.settings.roles;
  const [entries, setEntries] = useState<RolePanelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchRoleList());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error('Failed to load roles', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  if (selectedRoleId) {
    return (
      <RoleDetailPage
        roleId={selectedRoleId}
        icon={entries.find((e) => e.roleId === selectedRoleId)?.icon}
        onBack={() => {
          setSelectedRoleId(null);
          void loadList();
        }}
      />
    );
  }

  return (
    <SettingsPage
      title={t.settings.tabs.roles}
      description={roleText.description}
    >
      <SettingsSection
        title={`${roleText.listTitlePrefix}${entries.length}${roleText.listTitleSuffix}`}
        actions={
          <div className="flex items-center gap-2">
            <button /* ds-allow:button: 新建角色入口，emerald 语义色弱化胶囊，primitive 无对应变体 */
              type="button"
              onClick={() => void startCreateRoleChat()}
              className="flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/25"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {roleText.newRole}
            </button>
            <button /* ds-allow:button: 刷新图标按钮 p-1.5，primitive 变体会改变尺寸与外观 */
              type="button"
              onClick={() => void loadList()}
              title={roleText.refresh}
              className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      >
        {loading ? <div className="text-sm text-zinc-500">{roleText.loading}</div> : null}
        {error ? <div className="text-sm text-red-400">{error}</div> : null}
        {!loading && !error && entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700/70 p-6 text-center text-sm text-zinc-500">
            {roleText.empty}
          </div>
        ) : null}
        {groupRolesByCategory(entries, {
          categories: roleText.categories,
          uncategorized: roleText.uncategorizedCategory,
        }).map((group) => (
          <div key={group.key} className="mb-4 last:mb-0" data-role-category={group.key}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {group.label}{roleText.categoryCountPrefix}{group.entries.length}{roleText.categoryCountSuffix}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {group.entries.map((entry) => (
                <RoleCard
                  key={entry.roleId}
                  entry={entry}
                  labels={roleText.card}
                  onClick={() => setSelectedRoleId(entry.roleId)}
                />
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
};
