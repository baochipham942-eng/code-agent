// ============================================================================
// RolesTab - 持久化角色资产面板（设计 §7 最小版）
// 角色列表（名字/记忆条数/最近工作）→ 角色详情（定义只读 / 记忆可删可编辑 / 履历）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Brain, FileText, History, RefreshCw, Trash2, Pencil, X, Check, AlarmClock, UserPlus } from 'lucide-react';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelEntry, RolePanelDetail, RolePanelMemory, RoleProactivityLevel } from '@shared/contract/roleAssets';
import type { SkillCategory } from '@shared/contract/skillRepository';
import { SKILL_CATEGORIES } from '@shared/constants/skillCatalog';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { RoleIcon } from '../../shared/RoleIcon';
import { SettingsPage, SettingsSection, SettingsDetails } from '../SettingsLayout';

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

/** 取分类中文名（来自 SKILL_CATEGORIES）；未知 category 返回 undefined */
function categoryLabel(category: SkillCategory): string | undefined {
  return SKILL_CATEGORIES.find((c) => c.id === category)?.label;
}

/**
 * 按产物分类对角色分组（纯函数，供 UI + 单测）。
 * - 顺序跟随 SKILL_CATEGORIES，空分类不出现
 * - 无 category（用户自建角色）统一归入末尾"其他"组
 */
export function groupRolesByCategory(entries: RolePanelEntry[]): RoleCategoryGroup[] {
  const groups: RoleCategoryGroup[] = [];
  for (const meta of SKILL_CATEGORIES) {
    const inCategory = entries.filter((e) => e.category === meta.id);
    if (inCategory.length > 0) {
      groups.push({ key: meta.id, label: meta.label, entries: inCategory });
    }
  }
  const uncategorized = entries.filter((e) => !e.category || !categoryLabel(e.category));
  if (uncategorized.length > 0) {
    groups.push({ key: UNCATEGORIZED_KEY, label: '其他', entries: uncategorized });
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

async function fetchRoleDetail(roleId: string): Promise<RolePanelDetail> {
  return ipcService.invokeDomain<RolePanelDetail>(IPC_DOMAINS.ROLES, 'detail', { roleId });
}

async function deleteRoleMemory(roleId: string, filename: string): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'deleteMemory', { roleId, filename });
}

async function updateRoleMemory(roleId: string, memory: RolePanelMemory): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'updateMemory', {
    roleId,
    filename: memory.filename,
    name: memory.name,
    description: memory.description,
    content: memory.content,
  });
}

async function setRoleProactivity(roleId: string, level: RoleProactivityLevel): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'setProactivity', { roleId, level });
}

// ----------------------------------------------------------------------------
// 角色列表
// ----------------------------------------------------------------------------

interface RoleCardProps {
  entry: RolePanelEntry;
  onClick: () => void;
}

const RoleCard: React.FC<RoleCardProps> = ({ entry, onClick }) => (
  <button
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
          {entry.source === 'builtin' || entry.source === 'user' || entry.source === 'project' ? (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {entry.source === 'builtin' ? '预设' : entry.source === 'user' ? '自建' : '项目'}
            </span>
          ) : (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-400">缺定义</span>
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
        {entry.memoryCount} 条记忆
      </span>
      {entry.lastWork ? (
        <span className="flex min-w-0 items-center gap-1">
          <History className="h-3 w-3 shrink-0" />
          <span className="truncate">{entry.lastWork.replace(/^- /, '')}</span>
        </span>
      ) : (
        <span className="text-zinc-600">尚无工作记录</span>
      )}
    </div>
  </button>
);

// ----------------------------------------------------------------------------
// 记忆条目（可删可编辑）
// ----------------------------------------------------------------------------

interface MemoryRowProps {
  roleId: string;
  memory: RolePanelMemory;
  onChanged: () => void;
}

const MemoryRow: React.FC<MemoryRowProps> = ({ roleId, memory, onChanged }) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteRoleMemory(roleId, memory.filename);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error('Failed to delete role memory', err);
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  const handleSaveEdit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoleMemory(roleId, { ...memory, content: editContent });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error('Failed to update role memory', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-200">{memory.name}</div>
          <div className="mt-0.5 text-xs text-zinc-500">{memory.description}</div>
          <div className="mt-0.5 text-[10px] text-zinc-600">{memory.filename}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!editing && !confirmingDelete ? (
            <>
              <button
                type="button"
                title="编辑"
                onClick={() => setEditing(true)}
                className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-200"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="删除"
                onClick={() => setConfirmingDelete(true)}
                className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-red-900/40 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
          {confirmingDelete ? (
            <>
              <span className="text-xs text-red-400">确认删除？</span>
              <button
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/80 disabled:opacity-50"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700/60"
              >
                取消
              </button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={6}
            className="w-full rounded border border-zinc-600 bg-zinc-950/80 p-2 font-mono text-xs text-zinc-300 focus:border-zinc-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleSaveEdit}
              className="flex items-center gap-1 rounded bg-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
            >
              <Check className="h-3 w-3" /> 保存
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setEditContent(memory.content);
              }}
              className="flex items-center gap-1 rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-700/60"
            >
              <X className="h-3 w-3" /> 取消
            </button>
          </div>
        </div>
      ) : (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-xs text-zinc-400">
          {memory.content}
        </pre>
      )}

      {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// 主动性等级选择（docs/designs/role-proactivity.md §4.2）
// ----------------------------------------------------------------------------

const PROACTIVITY_OPTIONS: Array<{ value: RoleProactivityLevel; label: string; hint: string }> = [
  { value: 'silent', label: '静默', hint: '不会主动醒来（默认）' },
  { value: 'daily', label: '每日简报', hint: '每天 09:00 醒来巡检产物，有进展时生成简报会话' },
  { value: 'realtime', label: '实时介入', hint: '可自定义频率（每天最多 4 次）+ 有产出时桌面通知' },
];

interface ProactivitySelectorProps {
  roleId: string;
  current: RoleProactivityLevel;
  onChanged: () => void;
}

const ProactivitySelector: React.FC<ProactivitySelectorProps> = ({ roleId, current, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (level: RoleProactivityLevel) => {
    if (level === current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setRoleProactivity(roleId, level);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error('Failed to set role proactivity', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {PROACTIVITY_OPTIONS.map((option) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            disabled={busy}
            onClick={() => void handleSelect(option.value)}
            className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
              selected
                ? 'border-emerald-600/70 bg-emerald-900/20'
                : 'border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-500'
            } ${busy ? 'opacity-60' : ''}`}
          >
            <div
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                selected ? 'border-emerald-500' : 'border-zinc-600'
              }`}
            >
              {selected ? <div className="h-2 w-2 rounded-full bg-emerald-500" /> : null}
            </div>
            <div className="min-w-0">
              <div className={`text-sm ${selected ? 'text-emerald-300' : 'text-zinc-300'}`}>{option.label}</div>
              <div className="mt-0.5 text-xs text-zinc-500">{option.hint}</div>
            </div>
          </button>
        );
      })}
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// 角色详情
// ----------------------------------------------------------------------------

interface RoleDetailViewProps {
  roleId: string;
  /** 角色图标名（来自列表 entry；缺省兜底 UserCircle） */
  icon?: string;
  onBack: () => void;
}

const RoleDetailView: React.FC<RoleDetailViewProps> = ({ roleId, icon, onBack }) => {
  const [detail, setDetail] = useState<RolePanelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchRoleDetail(roleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error('Failed to load role detail', err);
    } finally {
      setLoading(false);
    }
  }, [roleId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> 返回角色列表
      </button>

      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
          <RoleIcon name={icon} className="h-7 w-7" />
        </div>
        <div>
          <h3 className="text-base font-medium text-zinc-200">{roleId}</h3>
          <p className="text-xs text-zinc-500">持久化角色 — 记忆与履历归你所有</p>
        </div>
      </header>

      {loading ? <div className="text-sm text-zinc-500">加载中…</div> : null}
      {error ? <div className="text-sm text-red-400">{error}</div> : null}

      {detail ? (
        <>
          {/* 主动性（定时醒来巡检产物） */}
          <SettingsSection
            title="主动性"
            description="角色定时醒来巡检自己经手的产物，自主决定推进 / 汇报 / 沉默。改动立即生效。"
          >
            <div className="flex items-start gap-2">
              <AlarmClock className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <ProactivitySelector
                  roleId={roleId}
                  current={detail.proactivity?.level ?? 'silent'}
                  onChanged={loadDetail}
                />
              </div>
            </div>
          </SettingsSection>

          {/* 记忆（可删可编辑） */}
          <SettingsSection
            title={`角色记忆（${detail.memories.length}）`}
            description="该角色跨项目积累的专业知识。删除后实例不再引用。"
          >
            {detail.memories.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
                暂无记忆 — 角色完成工作后会自动沉淀
              </div>
            ) : (
              <div className="space-y-2">
                {detail.memories.map((memory) => (
                  <MemoryRow key={memory.filename} roleId={roleId} memory={memory} onChanged={loadDetail} />
                ))}
              </div>
            )}
          </SettingsSection>

          {/* 履历（产物清单） */}
          <SettingsSection title="工作履历" description="该角色参与过的产物清单（最新在后）。">
            {detail.history.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
                暂无履历
              </div>
            ) : (
              <ul className="space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
                {[...detail.history].reverse().map((line, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                    <History className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
                    <span>{line.replace(/^- /, '')}</span>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>

          {/* 定义（只读） */}
          <SettingsDetails
            title="角色定义"
            description={detail.definition ? `只读展示 — 编辑请打开 ${detail.definitionPath}` : '未找到角色定义文件'}
          >
            {detail.definition ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-3 font-mono text-xs text-zinc-400">
                {detail.definition}
              </pre>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <FileText className="h-3.5 w-3.5" />
                该角色只有资产目录，没有 agent 定义文件（{detail.definitionPath}）
              </div>
            )}
          </SettingsDetails>
        </>
      ) : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// 主组件
// ----------------------------------------------------------------------------

export const RolesTab: React.FC = () => {
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
      <RoleDetailView
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
      title="角色"
      description="持久化角色 = 角色定义 + 角色记忆 + 工作履历。记忆与履历跨实例累积，归你所有。任何自定义 agent 在 ~/.code-agent/roles/ 下建同名目录即可升级为持久角色。"
    >
      <SettingsSection
        title={`持久化角色（${entries.length}）`}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void startCreateRoleChat()}
              className="flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/25"
            >
              <UserPlus className="h-3.5 w-3.5" />
              新建角色
            </button>
            <button
              type="button"
              onClick={() => void loadList()}
              title="刷新"
              className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      >
        {loading ? <div className="text-sm text-zinc-500">加载中…</div> : null}
        {error ? <div className="text-sm text-red-400">{error}</div> : null}
        {!loading && !error && entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700/70 p-6 text-center text-sm text-zinc-500">
            暂无持久化角色。重启应用后会自动安装预设角色（研究员 / 数据分析师）。
          </div>
        ) : null}
        {groupRolesByCategory(entries).map((group) => (
          <div key={group.key} className="mb-4 last:mb-0" data-role-category={group.key}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {group.label}（{group.entries.length}）
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {group.entries.map((entry) => (
                <RoleCard key={entry.roleId} entry={entry} onClick={() => setSelectedRoleId(entry.roleId)} />
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
};
