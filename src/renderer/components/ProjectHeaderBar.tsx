// ============================================================================
// ProjectHeaderBar - 项目空间 header（P0-2，挂在 Workspace Preview 顶部）
// ============================================================================
//
// 中心视图守则：产物列表占主区（仍是下方 Workspace Preview），本 header 提供项目维度的
// 目标 / 状态 / 入驻角色 / 跨 session 聚合产物入口。设计 docs/designs/project-space.md §6。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  Globe,
  LayoutGrid,
  Pencil,
  Plus,
  Search,
  Table2,
  Target,
  UserPlus,
  Video,
  X,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ProjectArtifact, ProjectDetail, ProjectGoal } from '@shared/contract/project';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import ipcService from '../services/ipcService';
import { RoleIcon } from './features/shared/RoleIcon';
import {
  addProjectGoal,
  addProjectRole,
  getProjectArtifacts,
  getProjectDetail,
  removeProjectRole,
  renameProject,
  setProjectStatus,
  updateProjectGoalStatus,
} from '../services/projectClient';
import { useSessionStore } from '../stores/sessionStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('ProjectHeaderBar');

const STATUS_LABEL: Record<string, string> = { active: '进行中', idle: '空闲', archived: '已归档' };
const GOAL_STATUS_LABEL: Record<string, string> = { active: '进行中', met: '已达成', aborted: '已终止', archived: '已归档' };

const ARTIFACT_ICON: Partial<Record<ProjectArtifact['kind'], React.ComponentType<{ className?: string }>>> = {
  chart: BarChart3,
  spreadsheet: Table2,
  document: FileText,
  generative_ui: LayoutGrid,
  mermaid: LayoutGrid,
  question_form: FileText,
  file: FileText,
  generic_html: LayoutGrid,
  web_snapshot: Globe,
  link: Globe,
  text: FileText,
  binary: File,
  image: ImageIcon,
  audio: File,
  video: Video,
  web: LayoutGrid,
  search: Search,
  'process-output': FileText,
  'process-log': FileText,
};

export const ProjectHeaderBar: React.FC = () => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const projectId = useMemo(
    () => sessions.find((s) => s.id === currentSessionId)?.projectId,
    [sessions, currentSessionId],
  );

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [goalDraft, setGoalDraft] = useState('');
  const [addingGoal, setAddingGoal] = useState(false);
  const [roleOptions, setRoleOptions] = useState<RolePanelEntry[]>([]);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setDetail(null);
      setArtifacts([]);
      return;
    }
    try {
      const [d, a] = await Promise.all([getProjectDetail(projectId), getProjectArtifacts(projectId)]);
      setDetail(d);
      setArtifacts(a);
    } catch (err) {
      logger.warn('加载项目详情失败', { err: err instanceof Error ? err.message : String(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRename = useCallback(async () => {
    if (!projectId || !nameDraft.trim()) {
      setEditingName(false);
      return;
    }
    try {
      await renameProject(projectId, nameDraft.trim());
      await refresh();
    } catch (err) {
      logger.warn('改名失败', { err: err instanceof Error ? err.message : String(err) });
    }
    setEditingName(false);
  }, [projectId, nameDraft, refresh]);

  const handleToggleArchive = useCallback(async () => {
    if (!detail) return;
    const next = detail.project.status === 'archived' ? 'active' : 'archived';
    try {
      await setProjectStatus(detail.project.id, next);
      await refresh();
    } catch (err) {
      logger.warn('切换归档失败', { err: err instanceof Error ? err.message : String(err) });
    }
  }, [detail, refresh]);

  const handleAddGoal = useCallback(async () => {
    if (!projectId || !goalDraft.trim()) {
      setAddingGoal(false);
      return;
    }
    try {
      await addProjectGoal(projectId, goalDraft.trim());
      setGoalDraft('');
      await refresh();
    } catch (err) {
      logger.warn('新增目标失败', { err: err instanceof Error ? err.message : String(err) });
    }
    setAddingGoal(false);
  }, [projectId, goalDraft, refresh]);

  const handleToggleGoal = useCallback(
    async (goal: ProjectGoal) => {
      const next = goal.status === 'met' ? 'active' : 'met';
      try {
        await updateProjectGoalStatus(goal.id, next);
        await refresh();
      } catch (err) {
        logger.warn('更新目标状态失败', { err: err instanceof Error ? err.message : String(err) });
      }
    },
    [refresh],
  );

  const openRolePicker = useCallback(async () => {
    setRolePickerOpen((prev) => !prev);
    if (roleOptions.length === 0) {
      try {
        const list = await ipcService.invokeDomain<RolePanelEntry[]>(IPC_DOMAINS.ROLES, 'list');
        setRoleOptions(list);
      } catch (err) {
        logger.warn('加载角色列表失败', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [roleOptions.length]);

  const handleAddRole = useCallback(
    async (roleId: string) => {
      if (!projectId) return;
      try {
        await addProjectRole(projectId, roleId);
        setRolePickerOpen(false);
        await refresh();
      } catch (err) {
        logger.warn('角色入驻失败', { err: err instanceof Error ? err.message : String(err) });
      }
    },
    [projectId, refresh],
  );

  const handleRemoveRole = useCallback(
    async (roleId: string) => {
      if (!projectId) return;
      try {
        await removeProjectRole(projectId, roleId);
        await refresh();
      } catch (err) {
        logger.warn('角色退出失败', { err: err instanceof Error ? err.message : String(err) });
      }
    },
    [projectId, refresh],
  );

  if (!projectId || !detail) return null;

  const joinedRoleIds = new Set(detail.roles.map((r) => r.roleId));
  const pickableRoles = roleOptions.filter((r) => !joinedRoleIds.has(r.roleId));

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-900/40 px-3 py-2 text-xs">
      {/* 标题行 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-zinc-300 hover:text-zinc-100"
          title="展开项目信息"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <FolderKanban className="h-3.5 w-3.5 text-indigo-400" />
        </button>

        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename();
              if (e.key === 'Escape') setEditingName(false);
            }}
            className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-zinc-100 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(detail.project.name);
              setEditingName(true);
            }}
            className="group flex min-w-0 flex-1 items-center gap-1 text-left font-medium text-zinc-200 hover:text-zinc-100"
            title="点击改名"
          >
            <span className="truncate">{detail.project.name}</span>
            <Pencil className="h-3 w-3 shrink-0 text-zinc-500 opacity-0 group-hover:opacity-100" />
          </button>
        )}

        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
            detail.project.status === 'active'
              ? 'bg-emerald-500/15 text-emerald-300'
              : detail.project.status === 'archived'
                ? 'bg-zinc-700/60 text-zinc-400'
                : 'bg-zinc-700/40 text-zinc-300'
          }`}
        >
          {STATUS_LABEL[detail.project.status] ?? detail.project.status}
        </span>
        <button
          type="button"
          onClick={handleToggleArchive}
          className="shrink-0 text-zinc-500 hover:text-zinc-300"
          title={detail.project.status === 'archived' ? '恢复项目' : '归档项目'}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 摘要行（折叠时） */}
      {!expanded && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1"><Target className="h-3 w-3" />{detail.goals.filter((g) => g.status === 'active').length} 目标</span>
          <span>{detail.roles.length} 角色</span>
          <span>{artifacts.length} 产物</span>
          <span>{detail.sessionIds.length} 会话</span>
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-3 pl-5 pr-1">
          {/* 目标 */}
          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1 font-medium text-zinc-400"><Target className="h-3 w-3" />目标</span>
              <button type="button" onClick={() => setAddingGoal((v) => !v)} className="text-zinc-500 hover:text-zinc-300" title="新增目标">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {addingGoal && (
              <input
                autoFocus
                value={goalDraft}
                onChange={(e) => setGoalDraft(e.target.value)}
                onBlur={handleAddGoal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddGoal();
                  if (e.key === 'Escape') setAddingGoal(false);
                }}
                placeholder="输入目标后回车"
                className="mb-1 w-full rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-zinc-100 outline-none"
              />
            )}
            {detail.goals.length === 0 ? (
              <p className="text-[11px] text-zinc-600">暂无目标</p>
            ) : (
              <ul className="space-y-1">
                {detail.goals.map((goal) => (
                  <li key={goal.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggleGoal(goal)}
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        goal.status === 'met' ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300' : 'border-zinc-600 text-transparent hover:border-zinc-400'
                      }`}
                      title={goal.status === 'met' ? '标记为进行中' : '标记为已达成'}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <span className={`min-w-0 flex-1 truncate ${goal.status === 'met' ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}>
                      {goal.goal}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-500">{GOAL_STATUS_LABEL[goal.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 入驻角色 */}
          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-zinc-400">入驻角色</span>
              <button type="button" onClick={openRolePicker} className="text-zinc-500 hover:text-zinc-300" title="角色入驻">
                <UserPlus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail.roles.length === 0 && <span className="text-[11px] text-zinc-600">暂无入驻角色</span>}
              {detail.roles.map((r) => (
                <span key={r.roleId} className="group flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                  {r.roleId}
                  <button type="button" onClick={() => handleRemoveRole(r.roleId)} className="text-zinc-500 hover:text-red-400" title="退出">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            {rolePickerOpen && (
              <div className="mt-1 max-h-32 overflow-auto rounded border border-zinc-700 bg-zinc-800/80 p-1">
                {pickableRoles.length === 0 ? (
                  <p className="px-1 py-0.5 text-[11px] text-zinc-500">没有可入驻的角色</p>
                ) : (
                  pickableRoles.map((r) => (
                    <button
                      key={r.roleId}
                      type="button"
                      onClick={() => handleAddRole(r.roleId)}
                      className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-zinc-300 hover:bg-zinc-700"
                    >
                      <RoleIcon name={r.icon} className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate">{r.roleId}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </section>

          {/* 项目维度产物（跨 session 聚合） */}
          <section>
            <div className="mb-1 font-medium text-zinc-400">项目产物 <span className="text-zinc-600">（跨 {detail.sessionIds.length} 会话）</span></div>
            {artifacts.length === 0 ? (
              <p className="text-[11px] text-zinc-600">暂无产物</p>
            ) : (
              <ul className="space-y-1">
                {artifacts.slice(0, 12).map((art) => {
                  const Icon = ARTIFACT_ICON[art.kind] ?? FileText;
                  return (
                    <li key={art.id} className="flex items-center gap-2 text-zinc-300">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate">{art.title || art.kind}</span>
                      {art.sessionTitle && <span className="max-w-[96px] shrink-0 truncate text-[10px] text-zinc-600">{art.sessionTitle}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default ProjectHeaderBar;
