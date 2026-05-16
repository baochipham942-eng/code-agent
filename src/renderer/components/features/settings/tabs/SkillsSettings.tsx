// ============================================================================
// SkillsSettings - Skill 库管理 Tab
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Package,
  RefreshCw,
  Trash2,
  Plus,
  Check,
  Loader2,
  AlertCircle,
  BookOpen,
  Search,
  X,
  AlertTriangle,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type {
  LocalSkillLibrary,
  LocalSkillInfo,
  SkillRepository,
} from '@shared/contract/skillRepository';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { SkillsDiscoveredSection } from './SkillsDiscoveredSection';
import {
  RecommendedRepoCard,
  SkillCheckbox,
  SkillSearchResultCard,
  type SkillsMPSearchResult,
} from './SkillsSettingsCards';
export { buildDiscoveredSkillSummary } from './SkillsDiscoveredSection';

// ============================================================================
// SkillsMP API Types
// ============================================================================

interface SkillsMPSearchResponse {
  success: boolean;
  data?: SkillsMPSearchResult[];
  total?: number;
  error?: {
    code: string;
    message: string;
  };
}

const logger = createLogger('SkillsSettings');

// Helper to invoke skill IPC channels (type-safe channels not yet registered)
 
const invokeSkillIPC = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  try {
    const invoke = ipcService.invoke as unknown as (
      ipcChannel: string,
      ...ipcArgs: unknown[]
    ) => Promise<T>;
    return await invoke(channel, ...args);
  } catch (err) {
    logger.error(`IPC invoke failed for ${channel}`, err);
    return undefined;
  }
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format timestamp to relative time
 */
const formatTime = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
};

export interface SkillLibraryManagementRow {
  repoId: string;
  repoName: string;
  localPath: string;
  version?: string;
  totalSkills: number;
  enabledSkills: number;
  disabledSkills: number;
  missingDependencySkills: number;
  lastUpdatedLabel: string;
  selected: boolean;
}

export interface SkillLibraryManagementSummary {
  libraryCount: number;
  totalSkills: number;
  enabledSkills: number;
  disabledSkills: number;
  missingDependencySkills: number;
}

export function resolveSelectedSkillLibraryId(
  libraries: LocalSkillLibrary[],
  selectedRepoId: string | null,
): string | null {
  if (selectedRepoId && libraries.some((library) => library.repoId === selectedRepoId)) {
    return selectedRepoId;
  }
  return libraries[0]?.repoId || null;
}

export function buildSkillLibraryManagementSummary(
  libraries: LocalSkillLibrary[],
): SkillLibraryManagementSummary {
  return libraries.reduce<SkillLibraryManagementSummary>((summary, library) => {
    const enabledSkills = library.skills.filter((skill) => skill.enabled).length;
    const missingDependencySkills = library.skills.filter((skill) =>
      skill.dependencyStatus && !skill.dependencyStatus.satisfied
    ).length;

    return {
      libraryCount: summary.libraryCount + 1,
      totalSkills: summary.totalSkills + library.skills.length,
      enabledSkills: summary.enabledSkills + enabledSkills,
      disabledSkills: summary.disabledSkills + (library.skills.length - enabledSkills),
      missingDependencySkills: summary.missingDependencySkills + missingDependencySkills,
    };
  }, {
    libraryCount: 0,
    totalSkills: 0,
    enabledSkills: 0,
    disabledSkills: 0,
    missingDependencySkills: 0,
  });
}

export function buildSkillLibraryManagementRows({
  libraries,
  selectedRepoId,
}: {
  libraries: LocalSkillLibrary[];
  selectedRepoId: string | null;
}): SkillLibraryManagementRow[] {
  const resolvedSelectedRepoId = resolveSelectedSkillLibraryId(libraries, selectedRepoId);

  return libraries.map((library) => {
    const enabledSkills = library.skills.filter((skill) => skill.enabled).length;
    const missingDependencySkills = library.skills.filter((skill) =>
      skill.dependencyStatus && !skill.dependencyStatus.satisfied
    ).length;

    return {
      repoId: library.repoId,
      repoName: library.repoName,
      localPath: library.localPath,
      version: library.version,
      totalSkills: library.skills.length,
      enabledSkills,
      disabledSkills: library.skills.length - enabledSkills,
      missingDependencySkills,
      lastUpdatedLabel: formatTime(library.lastUpdated),
      selected: library.repoId === resolvedSelectedRepoId,
    };
  });
}

// ============================================================================
// Main Component
// ============================================================================

export const SkillsSettings: React.FC = () => {
  // State
  const [libraries, setLibraries] = useState<LocalSkillLibrary[]>([]);
  const [discoveredSkills, setDiscoveredSkills] = useState<ParsedSkill[]>([]);
  const [recommendedRepos, setRecommendedRepos] = useState<SkillRepository[]>([]);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [skillFilter, setSkillFilter] = useState('');

  // SkillsMP Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillsMPSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState<number | undefined>();
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Load data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const libs = await invokeSkillIPC<LocalSkillLibrary[]>(SKILL_CHANNELS.REPO_LIST);
      const skills = await invokeSkillIPC<ParsedSkill[]>(SKILL_CHANNELS.SKILL_LIST);
      const repos = await invokeSkillIPC<SkillRepository[]>(SKILL_CHANNELS.RECOMMENDED_REPOS);
      setLibraries(libs || []);
      setDiscoveredSkills(skills || []);
      // Filter out already installed repos from recommendations
      const installedIds = new Set((libs || []).map((l) => l.repoId));
      setRecommendedRepos((repos || []).filter((r) => !installedIds.has(r.id)));
    } catch (err) {
      logger.error('Failed to load skill data', err);
      setMessage({ type: 'error', text: '加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    setSelectedLibraryId((current) => resolveSelectedSkillLibraryId(libraries, current));
  }, [libraries]);

  // Clear message after delay
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Download/Install repository
  const handleDownload = async (repo: SkillRepository) => {
    setActionLoading(repo.id);
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_DOWNLOAD,
        repo
      );
      if (result?.success) {
        setMessage({ type: 'success', text: `${repo.name} 安装成功` });
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || '安装失败' });
      }
    } catch (err) {
      logger.error('Failed to download repo', err);
      setMessage({ type: 'error', text: '安装失败' });
    } finally {
      setActionLoading(null);
    }
  };

  // Update repository
  const handleUpdate = async (repoId: string) => {
    setActionLoading(repoId);
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success: boolean; hasUpdates?: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_UPDATE,
        repoId
      );
      if (result?.success) {
        setMessage({
          type: 'success',
          text: result.hasUpdates ? '更新成功' : '已是最新版本',
        });
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || '更新失败' });
      }
    } catch (err) {
      logger.error('Failed to update repo', err);
      setMessage({ type: 'error', text: '更新失败' });
    } finally {
      setActionLoading(null);
    }
  };

  // Remove repository
  const handleRemove = async (repoId: string) => {
    if (!confirm('确定要删除这个 Skill 库吗？删除后需要重新下载。')) return;
    setActionLoading(`remove-${repoId}`);
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success?: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_REMOVE,
        repoId
      );
      if (result?.success !== false) {
        setMessage({ type: 'success', text: '删除成功' });
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || '删除失败' });
      }
    } catch (err) {
      logger.error('Failed to remove repo', err);
      setMessage({ type: 'error', text: '删除失败' });
    } finally {
      setActionLoading(null);
    }
  };

  // Add custom repository
  const handleAddCustom = async () => {
    const url = customUrl.trim();
    if (!url) return;

    // Basic URL validation
    if (!url.startsWith('https://github.com/')) {
      setMessage({ type: 'error', text: '请输入有效的 GitHub 仓库 URL' });
      return;
    }

    setActionLoading('custom');
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_ADD_CUSTOM,
        url
      );
      if (result?.success) {
        setMessage({ type: 'success', text: '仓库添加成功' });
        setCustomUrl('');
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || '添加失败' });
      }
    } catch (err) {
      logger.error('Failed to add custom repo', err);
      setMessage({ type: 'error', text: '添加失败' });
    } finally {
      setActionLoading(null);
    }
  };

  // Toggle skill enabled state
  const handleToggleSkill = async (skillName: string, enabled: boolean) => {
    try {
      if (enabled) {
        await invokeSkillIPC(SKILL_CHANNELS.SKILL_ENABLE, skillName);
      } else {
        await invokeSkillIPC(SKILL_CHANNELS.SKILL_DISABLE, skillName);
      }
      await loadData();
    } catch (err) {
      logger.error('Failed to toggle skill', err);
      setMessage({ type: 'error', text: '操作失败' });
    }
  };

  // SkillsMP Search
  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      // Use IPC to search via backend (which has API key access)
      const result = await invokeSkillIPC<SkillsMPSearchResponse>(
        SKILL_CHANNELS.SKILLSMP_SEARCH,
        query,
        10
      );

      if (!result) {
        setSearchError('搜索请求失败');
        return;
      }

      if (result.success && result.data) {
        setSearchResults(result.data);
        setSearchTotal(result.total);
        if (result.data.length === 0) {
          setSearchError('没有找到匹配的 Skill');
        }
      } else {
        setSearchError(result.error?.message || '搜索失败');
        setSearchTotal(undefined);
      }
    } catch (err) {
      logger.error('SkillsMP search failed', err);
      setSearchError('搜索服务暂时不可用，请稍后重试');
    } finally {
      setIsSearching(false);
    }
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchTotal(undefined);
    setSearchError(null);
  };

  // Install skill from SkillsMP (kept for potential future use)
   
  const handleInstallFromSkillsMP = async (skill: SkillsMPSearchResult) => {
    // Extract repo info from githubUrl: https://github.com/owner/repo/tree/branch/path
    const match = skill.githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
      setMessage({ type: 'error', text: '无法解析仓库地址' });
      return;
    }
    const repoUrl = `https://github.com/${match[1]}/${match[2]}`;
    setActionLoading(`skillsmp-${skill.id}`);
    setMessage(null);

    try {
      const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_ADD_CUSTOM,
        repoUrl
      );
      if (result?.success) {
        setMessage({ type: 'success', text: `${skill.name} 安装成功` });
        handleClearSearch();
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || '安装失败' });
      }
    } catch (err) {
      logger.error('Failed to install skill from SkillsMP', err);
      setMessage({ type: 'error', text: '安装失败' });
    } finally {
      setActionLoading(null);
    }
  };

  const resolvedSelectedLibraryId = resolveSelectedSkillLibraryId(libraries, selectedLibraryId);
  const selectedLibrary = useMemo(
    () => libraries.find((library) => library.repoId === resolvedSelectedLibraryId) || null,
    [libraries, resolvedSelectedLibraryId],
  );
  const librarySummary = useMemo(
    () => buildSkillLibraryManagementSummary(libraries),
    [libraries],
  );
  const libraryRows = useMemo(
    () => buildSkillLibraryManagementRows({
      libraries,
      selectedRepoId: resolvedSelectedLibraryId,
    }),
    [libraries, resolvedSelectedLibraryId],
  );
  const filteredSelectedSkills = useMemo(() => {
    if (!selectedLibrary) return [];
    const query = skillFilter.trim().toLowerCase();
    if (!query) return selectedLibrary.skills;
    return selectedLibrary.skills.filter((skill) =>
      skill.name.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.localPath.toLowerCase().includes(query)
    );
  }, [selectedLibrary, skillFilter]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <SettingsPage
      title="Skills"
      description="管理已安装的 Skill 库和启用状态。发现、搜索、安装类动作默认收在管理区。"
    >
      <WebModeBanner />

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <Check className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      <SettingsSection
        title="Skill 库管理"
        description="按仓库查看全局启用状态、依赖健康和更新状态。会话级挂载仍在右侧 Skills 面板里处理。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={loadData}
            disabled={loading}
            leftIcon={<RefreshCw className="w-3 h-3" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              ['Skill 库', String(librarySummary.libraryCount), '已安装仓库'],
              ['Skills', String(librarySummary.totalSkills), '本地可用数量'],
              ['已启用', String(librarySummary.enabledSkills), `${librarySummary.disabledSkills} 个未启用`],
              ['依赖缺口', String(librarySummary.missingDependencySkills), '需要补命令或环境变量'],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          {libraries.length === 0 ? (
            <div className="p-8 text-center">
              <Package className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
              <p className="text-sm text-zinc-400">还没有安装任何 Skill 库</p>
              <p className="mt-1 text-xs text-zinc-500">
                从下方推荐列表安装，或添加自定义仓库
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Skill 库</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">Skills</th>
                    <th className="px-3 py-2 font-medium">依赖</th>
                    <th className="px-3 py-2 font-medium">更新</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/80">
                  {libraryRows.map((row) => {
                    const isUpdating = actionLoading === row.repoId;
                    const isRemoving = actionLoading === `remove-${row.repoId}`;
                    return (
                      <tr
                        key={row.repoId}
                        className={row.selected ? 'bg-blue-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                      >
                        <td className="px-3 py-3 align-middle">
                          <button
                            type="button"
                            onClick={() => setSelectedLibraryId(row.repoId)}
                            className="block min-w-0 text-left"
                          >
                            <div className="flex items-center gap-2">
                              <BookOpen className="h-4 w-4 shrink-0 text-amber-300" />
                              <span className="truncate text-sm font-medium text-zinc-200">{row.repoName}</span>
                              <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                                {row.repoId}
                              </span>
                            </div>
                            <div className="mt-1 max-w-[300px] truncate font-mono text-[11px] text-zinc-500" title={row.localPath}>
                              {row.localPath}
                            </div>
                          </button>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {row.selected ? (
                            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                              <Check className="h-3 w-3" />
                              当前查看
                            </span>
                          ) : (
                            <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                              可查看
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-300">
                          <div>{row.totalSkills} 个 Skill</div>
                          <div className="mt-0.5 text-[11px] text-zinc-500">
                            {row.enabledSkills} 启用 / {row.disabledSkills} 关闭
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span className={row.missingDependencySkills > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                            {row.missingDependencySkills > 0 ? `${row.missingDependencySkills} 个缺依赖` : '依赖就绪'}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-400">
                          <div>{row.lastUpdatedLabel}</div>
                          <div className="mt-0.5 max-w-[150px] truncate font-mono text-[11px] text-zinc-600" title={row.version}>
                            {row.version || '未记录版本'}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleUpdate(row.repoId)}
                              loading={isUpdating}
                              leftIcon={!isUpdating ? <RefreshCw className="w-3 h-3" /> : undefined}
                              disabled={isRemoving || isWebMode()}
                            >
                              更新
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleRemove(row.repoId)}
                              loading={isRemoving}
                              leftIcon={!isRemoving ? <Trash2 className="w-3 h-3" /> : undefined}
                              disabled={isUpdating || isWebMode()}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            >
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>

      <SkillsDiscoveredSection skills={discoveredSkills} />

      {selectedLibrary && (
        <SettingsSection
          title="当前库详情"
          description={`${selectedLibrary.repoName} · ${selectedLibrary.skills.length} 个 Skills`}
        >
          <div className="grid gap-4 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    value={skillFilter}
                    onChange={(event) => setSkillFilter(event.target.value)}
                    placeholder="筛选 Skill 名称、描述或路径"
                    inputSize="sm"
                    leftIcon={<Search className="w-3 h-3" />}
                  />
                  {skillFilter && (
                    <button
                      type="button"
                      onClick={() => setSkillFilter('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="max-h-[360px] overflow-auto rounded-lg border border-zinc-800">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="sticky top-0 border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Skill</th>
                      <th className="px-3 py-2 font-medium">依赖</th>
                      <th className="px-3 py-2 text-right font-medium">启用</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/80">
                    {filteredSelectedSkills.map((skill) => {
                      const hasMissingDeps = skill.dependencyStatus && !skill.dependencyStatus.satisfied;
                      return (
                        <tr key={skill.name} className="bg-zinc-950/30 hover:bg-zinc-800/50">
                          <td className="px-3 py-3 align-top">
                            <div className="font-medium text-zinc-200">{skill.name}</div>
                            <div className="mt-1 line-clamp-2 text-zinc-500">{skill.description}</div>
                            <div className="mt-1 max-w-[360px] truncate font-mono text-[11px] text-zinc-600" title={skill.localPath}>
                              {skill.localPath}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            {hasMissingDeps ? (
                              <div className="space-y-1 text-amber-300">
                                <div className="inline-flex items-center gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  需要补依赖
                                </div>
                                <div className="max-w-[220px] text-[11px] text-amber-300/80">
                                  {[
                                    ...(skill.dependencyStatus?.missingBins || []),
                                    ...(skill.dependencyStatus?.missingEnvVars || []),
                                    ...(skill.dependencyStatus?.missingReferences || []),
                                  ].join(', ') || '依赖未满足'}
                                </div>
                              </div>
                            ) : (
                              <span className="text-emerald-300">依赖就绪</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right align-top">
                            <SkillCheckbox
                              skill={skill}
                              onToggle={handleToggleSkill}
                              disabled={Boolean(actionLoading)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                    {filteredSelectedSkills.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-3 py-8 text-center text-zinc-500">
                          没有匹配的 Skill
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <BookOpen className="h-4 w-4 text-amber-300" />
                库摘要
              </div>
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Repo</dt>
                  <dd className="truncate text-zinc-300">{selectedLibrary.repoName}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Skills</dt>
                  <dd className="text-zinc-300">{selectedLibrary.skills.length}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Updated</dt>
                  <dd className="text-zinc-300">{formatTime(selectedLibrary.lastUpdated)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Version</dt>
                  <dd className="max-w-[150px] truncate font-mono text-zinc-400" title={selectedLibrary.version}>
                    {selectedLibrary.version || '-'}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Path</dt>
                  <dd className="mt-1 break-all font-mono text-[11px] text-zinc-500">
                    {selectedLibrary.localPath}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsDetails
        title="发现与安装"
        description="推荐仓库、SkillsMP 搜索和自定义仓库添加放在这里，避免占用日常设置流。"
      >
      <div className="space-y-6">
      {/* Recommended Repos */}
      {recommendedRepos.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-zinc-200">推荐安装</h4>
          {recommendedRepos.map((repo) => (
            <RecommendedRepoCard
              key={repo.id}
              repo={repo}
              onInstall={handleDownload}
              isInstalling={actionLoading === repo.id}
            />
          ))}
        </div>
      )}

      {/* Search Skills from SkillsMP */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-200">搜索 Skill</h4>
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSearching) {
                    handleSearch();
                  }
                }}
                placeholder="输入需求，如：代码审查、Git 提交..."
                inputSize="sm"
                disabled={isSearching}
                className="pr-8"
              />
              {searchQuery && !isSearching && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-400"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              variant="primary"
              disabled={isWebMode() || !searchQuery.trim()}
              onClick={handleSearch}
              loading={isSearching}
              leftIcon={!isSearching ? <Search className="w-3 h-3" /> : undefined}
            >
              搜索
            </Button>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            从{' '}
            <a
              href="https://skillsmp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              SkillsMP
            </a>
            {' '}搜索 9 万+ 社区 Skills
          </p>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
              <div className="text-xs text-zinc-400 mb-2">
                {searchTotal
                  ? `共 ${searchTotal.toLocaleString()} 个结果，显示前 ${searchResults.length} 个：`
                  : `找到 ${searchResults.length} 个结果：`}
              </div>
              {searchResults.map((skill) => (
                <SkillSearchResultCard
                  key={skill.id}
                  skill={skill}
                  onInstall={handleInstallFromSkillsMP}
                  isInstalling={actionLoading === `skillsmp-${skill.id}`}
                />
              ))}
            </div>
          )}

          {/* Search Error */}
          {searchError && (
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              <AlertCircle className="w-3 h-3" />
              {searchError}
            </div>
          )}
        </div>
      </div>

      {/* Add Custom Repository */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-200">添加自定义 Skill 库</h4>
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4">
          <div className="space-y-2">
            <Input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://github.com/user/my-skills"
              inputSize="sm"
              disabled={actionLoading === 'custom'}
            />
            <p className="text-xs text-zinc-500">
              输入 GitHub 仓库 URL，仓库根目录需包含 skill 目录结构
            </p>
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={isWebMode() || !customUrl.trim()}
              onClick={handleAddCustom}
              loading={actionLoading === 'custom'}
              leftIcon={!actionLoading ? <Plus className="w-3 h-3" /> : undefined}
            >
              添加仓库
            </Button>
          </div>
        </div>
      </div>

      </div>
      </SettingsDetails>

    </SettingsPage>
  );
};
