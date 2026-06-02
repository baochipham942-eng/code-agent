// ============================================================================
// SkillsSettings - Skills 管理 Tab（已安装 / 发现安装）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../primitives';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type { LocalSkillLibrary, SkillRepository } from '@shared/contract/skillRepository';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import { createLogger } from '../../../../utils/logger';
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
  // 视图状态
  const [activeTab, setActiveTab] = useState<SkillsViewTab>('installed');

  // 数据状态
  const [libraries, setLibraries] = useState<LocalSkillLibrary[]>([]);
  const [discoveredSkills, setDiscoveredSkills] = useState<ParsedSkill[]>([]);
  const [recommendedRepos, setRecommendedRepos] = useState<SkillRepository[]>([]);
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

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const libs = await invokeSkillIPC<LocalSkillLibrary[]>(SKILL_CHANNELS.REPO_LIST);
      const skills = await invokeSkillIPC<ParsedSkill[]>(SKILL_CHANNELS.SKILL_LIST);
      const repos = await invokeSkillIPC<SkillRepository[]>(SKILL_CHANNELS.RECOMMENDED_REPOS);
      setLibraries(libs || []);
      setDiscoveredSkills(skills || []);
      // 推荐列表里排除已安装的仓库
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
      setMessage({ type: 'error', text: '操作失败' });
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
        setMessage({ type: 'success', text: `${repo.name} 安装成功` });
        setActiveTab('installed');
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

  // 删除仓库
  const handleRemoveLibrary = async (repoId: string) => {
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

  // 添加自定义仓库
  const handleAddCustom = async () => {
    const url = customUrl.trim();
    if (!url) return;

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
        setActiveTab('installed');
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
        setActiveTab('installed');
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
            ['installed', `已安装 (${discoveredSkills.length})`],
            ['discover', '发现安装'],
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
          刷新
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
          recommendedRepos={recommendedRepos}
          actionLoading={actionLoading}
          onInstallRepo={handleInstallRepo}
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
