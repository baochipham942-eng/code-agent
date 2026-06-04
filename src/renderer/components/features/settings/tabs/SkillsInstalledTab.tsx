// ============================================================================
// SkillsInstalledTab - 已安装 Skills（按来源分组列表 + 全局启停）
// ============================================================================

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Package,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import type { LocalSkillLibrary, SkillCategory } from '@shared/contract/skillRepository';
import { SKILL_CATEGORIES } from '@shared/constants/skillCatalog';
import { Button, Input, Toggle } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';

// ============================================================================
// 分组与摘要（导出供测试）
// ============================================================================

export type SkillGroupKind = 'builtin' | 'project' | 'user' | 'library';

export interface InstalledSkillGroup {
  /** 分组唯一键：builtin / project / user / library:<repoId> */
  key: string;
  kind: SkillGroupKind;
  label: string;
  /** library 组对应的仓库 ID（仅 library 组有） */
  repoId?: string;
  skills: ParsedSkill[];
}

export interface InstalledSkillSummary {
  totalSkills: number;
  libraryCount: number;
  disabledSkills: number;
  missingDependencySkills: number;
}

const GROUP_LABELS: Record<Exclude<SkillGroupKind, 'library'>, string> = {
  builtin: '内置',
  project: '项目',
  user: '用户',
};

/** 按组排序：内置 → 项目 → 用户 → 库 */
const GROUP_ORDER: Record<SkillGroupKind, number> = {
  builtin: 0,
  project: 1,
  user: 2,
  library: 3,
};

function sortSkills(skills: ParsedSkill[]): ParsedSkill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

// ----------------------------------------------------------------------------
// 内置组按产物分类二次分组（P2-2：复用 7 类 SkillCategory）
// ----------------------------------------------------------------------------

const UNCATEGORIZED_SKILL_KEY = '__uncategorized__';

export interface SkillCategorySubGroup {
  /** 分类 key：SkillCategory 或 UNCATEGORIZED_SKILL_KEY */
  key: string;
  label: string;
  skills: ParsedSkill[];
}

/** 取 skill 的产物分类（来自 metadata.category，由 builtinSkills 回填） */
function skillCategoryId(skill: ParsedSkill): SkillCategory | undefined {
  const raw = skill.metadata?.category;
  if (!raw) return undefined;
  return SKILL_CATEGORIES.some((c) => c.id === raw) ? (raw as SkillCategory) : undefined;
}

/**
 * 把内置 skill 按产物分类分组（纯函数，供 UI + 单测）。
 * - 顺序跟随 SKILL_CATEGORIES，空分类不出现
 * - 无 category 的内置 skill 统一归入末尾"其他"组
 * - 组内 skill 按名排序（与来源组一致）
 */
export function groupBuiltinSkillsByCategory(skills: ParsedSkill[]): SkillCategorySubGroup[] {
  const groups: SkillCategorySubGroup[] = [];
  for (const meta of SKILL_CATEGORIES) {
    const inCategory = skills.filter((s) => skillCategoryId(s) === meta.id);
    if (inCategory.length > 0) {
      groups.push({ key: meta.id, label: meta.label, skills: sortSkills(inCategory) });
    }
  }
  const uncategorized = skills.filter((s) => !skillCategoryId(s));
  if (uncategorized.length > 0) {
    groups.push({ key: UNCATEGORIZED_SKILL_KEY, label: '其他', skills: sortSkills(uncategorized) });
  }
  return groups;
}

/**
 * 找到 library skill 所属的库（按 basePath 前缀匹配）
 */
export function findLibraryForSkill(
  skill: ParsedSkill,
  libraries: LocalSkillLibrary[],
): LocalSkillLibrary | undefined {
  if (skill.source !== 'library' || !skill.basePath) return undefined;
  return libraries.find((library) => skill.basePath.startsWith(library.localPath));
}

/**
 * 把发现的 skills 按来源分组：
 * - builtin + cloud → 内置
 * - project → 项目
 * - user → 用户
 * - library → 按所属库分组（组头带更新/删除操作）
 */
export function buildInstalledSkillGroups(
  skills: ParsedSkill[],
  libraries: LocalSkillLibrary[],
): InstalledSkillGroup[] {
  const builtin: ParsedSkill[] = [];
  const project: ParsedSkill[] = [];
  const user: ParsedSkill[] = [];
  const byLibrary = new Map<string, ParsedSkill[]>();
  const orphanLibrarySkills: ParsedSkill[] = [];

  for (const skill of skills) {
    switch (skill.source) {
      case 'builtin':
      case 'cloud':
        builtin.push(skill);
        break;
      case 'project':
        project.push(skill);
        break;
      case 'library': {
        const library = findLibraryForSkill(skill, libraries);
        if (library) {
          const list = byLibrary.get(library.repoId) || [];
          list.push(skill);
          byLibrary.set(library.repoId, list);
        } else {
          orphanLibrarySkills.push(skill);
        }
        break;
      }
      // user / plugin 都归入用户目录组
      default:
        user.push(skill);
        break;
    }
  }

  const groups: InstalledSkillGroup[] = [];

  if (builtin.length > 0) {
    groups.push({ key: 'builtin', kind: 'builtin', label: GROUP_LABELS.builtin, skills: sortSkills(builtin) });
  }
  if (project.length > 0) {
    groups.push({ key: 'project', kind: 'project', label: GROUP_LABELS.project, skills: sortSkills(project) });
  }
  if (user.length > 0) {
    groups.push({ key: 'user', kind: 'user', label: GROUP_LABELS.user, skills: sortSkills(user) });
  }

  // 每个已下载的库一个组（即使扫描到 0 个 skill 也展示，便于管理）
  for (const library of libraries) {
    const librarySkills = byLibrary.get(library.repoId) || [];
    groups.push({
      key: `library:${library.repoId}`,
      kind: 'library',
      label: library.repoName,
      repoId: library.repoId,
      skills: sortSkills(librarySkills),
    });
  }

  // 匹配不到库的 library skill 兜底成一个组
  if (orphanLibrarySkills.length > 0) {
    groups.push({
      key: 'library:unknown',
      kind: 'library',
      label: '未知库',
      skills: sortSkills(orphanLibrarySkills),
    });
  }

  return groups.sort((a, b) => {
    if (GROUP_ORDER[a.kind] !== GROUP_ORDER[b.kind]) {
      return GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind];
    }
    return a.label.localeCompare(b.label);
  });
}

/**
 * 汇总摘要（一行内联文字，替代旧版统计卡片）
 */
export function buildInstalledSkillSummary(
  skills: ParsedSkill[],
  libraries: LocalSkillLibrary[],
): InstalledSkillSummary {
  return {
    totalSkills: skills.length,
    libraryCount: libraries.length,
    disabledSkills: skills.filter((skill) => skill.enabled === false).length,
    missingDependencySkills: skills.filter(
      (skill) => skill.dependencyStatus && !skill.dependencyStatus.satisfied
    ).length,
  };
}

/**
 * 按关键词过滤分组（名称/描述匹配），空组被移除
 */
export function filterSkillGroups(
  groups: InstalledSkillGroup[],
  query: string,
): InstalledSkillGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return groups;

  return groups
    .map((group) => ({
      ...group,
      skills: group.skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(normalized)
          || skill.description.toLowerCase().includes(normalized)
      ),
    }))
    .filter((group) => group.skills.length > 0);
}

// ============================================================================
// 行组件
// ============================================================================

interface SkillRowProps {
  skill: ParsedSkill;
  onToggle: (skillName: string, enabled: boolean) => void;
  toggleDisabled?: boolean;
}

const SkillRow: React.FC<SkillRowProps> = ({ skill, onToggle, toggleDisabled }) => {
  const hasMissingDeps = skill.dependencyStatus && !skill.dependencyStatus.satisfied;
  const missingDepsTitle = hasMissingDeps
    ? [
        ...(skill.dependencyStatus?.missingBins || []),
        ...(skill.dependencyStatus?.missingEnvVars || []),
        ...(skill.dependencyStatus?.missingReferences || []),
      ].join(', ')
    : undefined;
  const enabled = skill.enabled !== false;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-sm font-medium ${enabled ? 'text-zinc-200' : 'text-zinc-500'}`}>
            {skill.name}
          </span>
          {hasMissingDeps && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-amber-400"
              title={`缺少依赖: ${missingDepsTitle}`}
            >
              <AlertTriangle className="h-3 w-3" />
              缺依赖
            </span>
          )}
        </div>
        <p className={`mt-0.5 truncate text-xs ${enabled ? 'text-zinc-500' : 'text-zinc-600'}`} title={skill.description}>
          {skill.description}
        </p>
      </div>
      <Toggle
        checked={enabled}
        onChange={(next) => onToggle(skill.name, next)}
        disabled={toggleDisabled}
        aria-label={`启用 ${skill.name}`}
      />
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export interface SkillsInstalledTabProps {
  skills: ParsedSkill[];
  libraries: LocalSkillLibrary[];
  actionLoading: string | null;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onUpdateLibrary: (repoId: string) => void;
  onRemoveLibrary: (repoId: string) => void;
}

export const SkillsInstalledTab: React.FC<SkillsInstalledTabProps> = ({
  skills,
  libraries,
  actionLoading,
  onToggleSkill,
  onUpdateLibrary,
  onRemoveLibrary,
}) => {
  const [query, setQuery] = useState('');

  const summary = useMemo(() => buildInstalledSkillSummary(skills, libraries), [skills, libraries]);
  const groups = useMemo(() => buildInstalledSkillGroups(skills, libraries), [skills, libraries]);
  const filteredGroups = useMemo(() => filterSkillGroups(groups, query), [groups, query]);

  return (
    <div className="space-y-3">
      {/* 摘要 + 搜索 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          {summary.totalSkills} 个 Skill · {summary.libraryCount} 个库
          {summary.disabledSkills > 0 && (
            <span> · {summary.disabledSkills} 已禁用</span>
          )}
          {summary.missingDependencySkills > 0 && (
            <span className="text-amber-400"> · {summary.missingDependencySkills} 依赖缺口</span>
          )}
        </p>
        <div className="relative w-56">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Skill"
            inputSize="sm"
            leftIcon={<Search className="h-3 w-3" />}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 分组列表 */}
      {filteredGroups.length === 0 ? (
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-8 text-center">
          <Package className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
          <p className="text-sm text-zinc-400">
            {query ? '没有匹配的 Skill' : '还没有发现 Skill'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredGroups.map((group) => {
            const isUpdating = group.repoId ? actionLoading === group.repoId : false;
            const isRemoving = group.repoId ? actionLoading === `remove-${group.repoId}` : false;

            return (
              <div key={group.key} className="overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/60">
                {/* 组头 */}
                <div className="flex items-center justify-between gap-3 border-b border-zinc-700/60 bg-zinc-800/60 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {group.kind === 'library' && <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                    <span className="truncate text-xs font-medium text-zinc-300">
                      {group.label}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">({group.skills.length})</span>
                  </div>
                  {group.kind === 'library' && group.repoId && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onUpdateLibrary(group.repoId!)}
                        loading={isUpdating}
                        leftIcon={!isUpdating ? <RefreshCw className="h-3 w-3" /> : undefined}
                        disabled={isRemoving || isWebMode()}
                      >
                        更新
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRemoveLibrary(group.repoId!)}
                        loading={isRemoving}
                        leftIcon={!isRemoving ? <Trash2 className="h-3 w-3" /> : undefined}
                        disabled={isUpdating || isWebMode()}
                        className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        删除
                      </Button>
                    </div>
                  )}
                </div>

                {/* 组内 skill 行：内置组按产物分类二次分组，其余组平铺 */}
                {group.skills.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-zinc-500">该库中没有可用的 Skill</p>
                ) : group.kind === 'builtin' ? (
                  <div>
                    {groupBuiltinSkillsByCategory(group.skills).map((sub) => (
                      <div key={sub.key} data-skill-category={sub.key}>
                        <div className="border-b border-zinc-800/60 bg-zinc-900/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                          {sub.label}（{sub.skills.length}）
                        </div>
                        <div className="divide-y divide-zinc-800/80">
                          {sub.skills.map((skill) => (
                            <SkillRow
                              key={`${skill.source}:${skill.basePath || skill.name}`}
                              skill={skill}
                              onToggle={onToggleSkill}
                              toggleDisabled={Boolean(actionLoading)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-800/80">
                    {group.skills.map((skill) => (
                      <SkillRow
                        key={`${skill.source}:${skill.basePath || skill.name}`}
                        skill={skill}
                        onToggle={onToggleSkill}
                        toggleDisabled={Boolean(actionLoading)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
