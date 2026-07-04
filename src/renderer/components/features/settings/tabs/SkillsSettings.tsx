// ============================================================================
// SkillsSettings - Skills 管理 Tab（已安装 / 发现安装）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../primitives';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type {
  LocalSkillLibrary,
  SkillCatalogPayload,
  SkillRepository,
  SkillRoleBundle,
} from '@shared/contract/skillRepository';
import { BUILTIN_REPO_ID } from '@shared/contract/skillRepository';
import {
  findRecommendedRepository,
  getBuiltinSkillCatalogPayload,
} from '@shared/constants/skillCatalog';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import { createLogger } from '../../../../utils/logger';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { SkillsInstalledTab } from './SkillsInstalledTab';
import { SkillsDiscoverTab } from './SkillsDiscoverTab';
import type { SkillsMPSearchResult } from './SkillsSettingsCards';

// 分组/摘要工具函数集中在 SkillsInstalledTab，测试也从那里引用
export {
  buildInstalledSkillGroups,
  buildInstalledSkillSummary,
  filterSkillGroups,
  findLibraryForSkill,
} from './SkillsInstalledTab';

// ============================================================================
// Types
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

type SkillsViewTab = 'installed' | 'discover';

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
// Main Component
// ============================================================================

export const SkillsSettings: React.FC = () => {
  const { t } = useI18n();
  const skillsText = t.settings.skills.main;
  const settingsCapabilityFocus = useAppStore((state) => state.settingsCapabilityFocus);
  const clearSettingsCapabilityFocus = useAppStore((state) => state.clearSettingsCapabilityFocus);
  // 视图状态
  const [activeTab, setActiveTab] = useState<SkillsViewTab>('installed');

  // 数据状态
  const [libraries, setLibraries] = useState<LocalSkillLibrary[]>([]);
  const [discoveredSkills, setDiscoveredSkills] = useState<ParsedSkill[]>([]);
  const [recommendedRepos, setRecommendedRepos] = useState<SkillRepository[]>([]);
  // 推荐目录：内置数据为初始值，云端下发到达后覆盖（web 模式 IPC 不可用时保持内置）
  const [catalog, setCatalog] = useState<SkillCatalogPayload>(getBuiltinSkillCatalogPayload);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // SkillsMP 搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillsMPSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState<number | undefined>();
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsCapabilityFocus?.kind === 'skill') {
      setActiveTab('installed');
    }
  }, [settingsCapabilityFocus?.kind, settingsCapabilityFocus?.nonce]);

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const libs = await invokeSkillIPC<LocalSkillLibrary[]>(SKILL_CHANNELS.REPO_LIST);
      const skills = await invokeSkillIPC<ParsedSkill[]>(SKILL_CHANNELS.SKILL_LIST);
      const repos = await invokeSkillIPC<SkillRepository[]>(SKILL_CHANNELS.RECOMMENDED_REPOS);
      const remoteCatalog = await invokeSkillIPC<SkillCatalogPayload>(SKILL_CHANNELS.CATALOG);
      setLibraries(libs || []);
      setDiscoveredSkills(skills || []);
      if (remoteCatalog) {
        setCatalog(remoteCatalog);
      }
      // 推荐列表里排除已安装的仓库
      const installedIds = new Set((libs || []).map((l) => l.repoId));
      setRecommendedRepos((repos || []).filter((r) => !installedIds.has(r.id)));
    } catch (err) {
      logger.error('Failed to load skill data', err);
      setMessage({ type: 'error', text: skillsText.loadFailed });
    } finally {
      setLoading(false);
    }
  }, [skillsText.loadFailed]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 消息自动消失
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // 启停 skill（乐观更新，失败回滚）
  const handleToggleSkill = async (skillName: string, enabled: boolean) => {
    const previous = discoveredSkills;
    setDiscoveredSkills((current) =>
      current.map((skill) => (skill.name === skillName ? { ...skill, enabled } : skill))
    );
    try {
      await invokeSkillIPC(
        enabled ? SKILL_CHANNELS.SKILL_ENABLE : SKILL_CHANNELS.SKILL_DISABLE,
        skillName
      );
    } catch (err) {
      logger.error('Failed to toggle skill', err);
      setDiscoveredSkills(previous);
      setMessage({ type: 'error', text: skillsText.actionFailed });
    }
  };

  // 安装仓库
  const handleInstallRepo = async (repo: SkillRepository) => {
    setActionLoading(repo.id);
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_DOWNLOAD,
        repo
      );
      if (result?.success) {
        setMessage({ type: 'success', text: `${repo.name}${skillsText.installSuccessSuffix}` });
        setActiveTab('installed');
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || skillsText.installFailed });
      }
    } catch (err) {
      logger.error('Failed to download repo', err);
      setMessage({ type: 'error', text: skillsText.installFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // 安装角色场景包：下载包内 skill 涉及的所有未安装仓库
  const handleInstallBundle = async (bundle: SkillRoleBundle) => {
    const installedIds = new Set(libraries.map((lib) => lib.repoId));
    const missingRepoIds = [
      ...new Set(
        bundle.skills
          .map((skill) => skill.repoId)
          .filter((repoId) => repoId !== BUILTIN_REPO_ID && !installedIds.has(repoId))
      ),
    ];
    if (missingRepoIds.length === 0) return;

    setActionLoading(`bundle-${bundle.id}`);
    setMessage(null);
    try {
      const failures: string[] = [];
      for (const repoId of missingRepoIds) {
        const repo = findRecommendedRepository(repoId, catalog.repositories);
        if (!repo) {
          failures.push(repoId);
          continue;
        }
        const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
          SKILL_CHANNELS.REPO_DOWNLOAD,
          repo
        );
        if (!result?.success) {
          failures.push(repo.name);
        }
      }
      if (failures.length === 0) {
        setMessage({ type: 'success', text: `${bundle.name}${skillsText.installSuccessSuffix}` });
        setActiveTab('installed');
      } else {
        setMessage({ type: 'error', text: `${skillsText.partialInstallFailedPrefix}${failures.join(', ')}` });
      }
      await loadData();
    } catch (err) {
      logger.error('Failed to install bundle', err);
      setMessage({ type: 'error', text: skillsText.installFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // 更新仓库
  const handleUpdateLibrary = async (repoId: string) => {
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
          text: result.hasUpdates ? skillsText.updateSuccess : skillsText.alreadyLatest,
        });
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || skillsText.updateFailed });
      }
    } catch (err) {
      logger.error('Failed to update repo', err);
      setMessage({ type: 'error', text: skillsText.updateFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // 删除仓库
  const handleRemoveLibrary = async (repoId: string) => {
    if (!confirm(skillsText.removeConfirm)) return;
    setActionLoading(`remove-${repoId}`);
    setMessage(null);
    try {
      const result = await invokeSkillIPC<{ success?: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_REMOVE,
        repoId
      );
      if (result?.success !== false) {
        setMessage({ type: 'success', text: skillsText.removeSuccess });
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || skillsText.removeFailed });
      }
    } catch (err) {
      logger.error('Failed to remove repo', err);
      setMessage({ type: 'error', text: skillsText.removeFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // 添加自定义仓库
  const handleAddCustom = async () => {
    const url = customUrl.trim();
    if (!url) return;

    if (!url.startsWith('https://github.com/')) {
      setMessage({ type: 'error', text: skillsText.invalidGithubUrl });
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
        setMessage({ type: 'success', text: skillsText.repoAdded });
        setCustomUrl('');
        setActiveTab('installed');
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || skillsText.addFailed });
      }
    } catch (err) {
      logger.error('Failed to add custom repo', err);
      setMessage({ type: 'error', text: skillsText.addFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // SkillsMP 搜索
  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      const result = await invokeSkillIPC<SkillsMPSearchResponse>(
        SKILL_CHANNELS.SKILLSMP_SEARCH,
        query,
        10
      );

      if (!result) {
        setSearchError(skillsText.searchRequestFailed);
        return;
      }

      if (result.success && result.data) {
        setSearchResults(result.data);
        setSearchTotal(result.total);
        if (result.data.length === 0) {
          setSearchError(skillsText.noMatchingSkill);
        }
      } else {
        setSearchError(result.error?.message || skillsText.searchFailed);
        setSearchTotal(undefined);
      }
    } catch (err) {
      logger.error('SkillsMP search failed', err);
      setSearchError(skillsText.searchServiceUnavailable);
    } finally {
      setIsSearching(false);
    }
  };

  // 清空搜索
  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchTotal(undefined);
    setSearchError(null);
  };

  // 从 SkillsMP 安装
  const handleInstallFromSearch = async (skill: SkillsMPSearchResult) => {
    const match = skill.githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
      setMessage({ type: 'error', text: skillsText.cannotParseRepoUrl });
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
        setMessage({ type: 'success', text: `${skill.name}${skillsText.installSuccessSuffix}` });
        handleClearSearch();
        setActiveTab('installed');
        await loadData();
      } else {
        setMessage({ type: 'error', text: result?.error || skillsText.installFailed });
      }
    } catch (err) {
      logger.error('Failed to install skill from SkillsMP', err);
      setMessage({ type: 'error', text: skillsText.installFailed });
    } finally {
      setActionLoading(null);
    }
  };

  // 加载中
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    // 弹窗头部已展示「Skills / 能力与连接」标题，内容区直接从 Tab 开始，不再叠标题
    <div className="space-y-6">
      <WebModeBanner />

      {settingsCapabilityFocus?.kind === 'skill' && (
        <div className="flex flex-col gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2 text-sm text-sky-100 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {skillsText.focusPromptPrefix}<span className="font-mono">{settingsCapabilityFocus.id}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSettingsCapabilityFocus}
          >
            {skillsText.closeFocusPrompt}
          </Button>
        </div>
      )}

      {/* 操作结果消息 */}
      {message && (
        <div
          className={`flex items-center gap-2 rounded-lg p-3 ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Tab 切换 + 刷新 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg bg-zinc-800/80 p-1">
          {([
            ['installed', `${skillsText.installedTabPrefix}${discoveredSkills.length}${skillsText.installedTabSuffix}`],
            ['discover', skillsText.discoverTab],
          ] as Array<[SkillsViewTab, string]>).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={loadData}
          disabled={loading}
          leftIcon={<RefreshCw className="h-3 w-3" />}
        >
          {skillsText.refresh}
        </Button>
      </div>

      {/* Tab 内容 */}
      {activeTab === 'installed' ? (
        <SkillsInstalledTab
          skills={discoveredSkills}
          libraries={libraries}
          actionLoading={actionLoading}
          onToggleSkill={handleToggleSkill}
          onUpdateLibrary={handleUpdateLibrary}
          onRemoveLibrary={handleRemoveLibrary}
        />
      ) : (
        <SkillsDiscoverTab
          catalog={catalog}
          recommendedRepos={recommendedRepos}
          installedRepoIds={new Set(libraries.map((lib) => lib.repoId))}
          installedSkillNames={new Set(discoveredSkills.map((skill) => skill.name))}
          actionLoading={actionLoading}
          onInstallRepo={handleInstallRepo}
          onInstallBundle={handleInstallBundle}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchResults={searchResults}
          searchTotal={searchTotal}
          isSearching={isSearching}
          searchError={searchError}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          onInstallFromSearch={handleInstallFromSearch}
          customUrl={customUrl}
          onCustomUrlChange={setCustomUrl}
          onAddCustom={handleAddCustom}
        />
      )}
    </div>
  );
};
