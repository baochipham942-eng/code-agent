// ============================================================================
// SkillsSettings - Skill 库管理 Tab
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Package,
  RefreshCw,
  Trash2,
  Plus,
  Check,
  ExternalLink,
  Loader2,
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type {
  LocalSkillLibrary,
  LocalSkillInfo,
  SkillRepository,
} from '@shared/types/skillRepository';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('SkillsSettings');

// Helper to invoke skill IPC channels (type-safe channels not yet registered)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invokeSkillIPC = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (window.electronAPI?.invoke as any)(channel, ...args) as T;
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

// ============================================================================
// Sub Components
// ============================================================================

interface SkillCheckboxProps {
  skill: LocalSkillInfo;
  onToggle: (skillName: string, enabled: boolean) => void;
  disabled?: boolean;
}

const SkillCheckbox: React.FC<SkillCheckboxProps> = ({ skill, onToggle, disabled }) => {
  return (
    <label
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors ${
        skill.enabled
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <input
        type="checkbox"
        checked={skill.enabled}
        onChange={(e) => onToggle(skill.name, e.target.checked)}
        disabled={disabled}
        className="sr-only"
      />
      <span
        className={`w-3 h-3 rounded border flex items-center justify-center ${
          skill.enabled ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-500'
        }`}
      >
        {skill.enabled && <Check className="w-2 h-2 text-white" />}
      </span>
      <span>{skill.name}</span>
    </label>
  );
};

interface LibraryCardProps {
  library: LocalSkillLibrary;
  onUpdate: (repoId: string) => void;
  onRemove: (repoId: string) => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  isUpdating: boolean;
  isRemoving: boolean;
}

const LibraryCard: React.FC<LibraryCardProps> = ({
  library,
  onUpdate,
  onRemove,
  onToggleSkill,
  isUpdating,
  isRemoving,
}) => {
  const [expanded, setExpanded] = useState(false);
  const enabledCount = library.skills.filter((s) => s.enabled).length;
  const visibleSkills = expanded ? library.skills : library.skills.slice(0, 5);
  const hasMore = library.skills.length > 5;

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 overflow-hidden">
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <h4 className="text-sm font-medium text-zinc-100">{library.repoName}</h4>
              <div className="flex items-center gap-2 mt-1 text-xs text-zinc-400">
                <span>{library.skills.length} skills</span>
                <span>·</span>
                <span>上次更新: {formatTime(library.lastUpdated)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Skills */}
        <div className="mt-4">
          <div className="text-xs text-zinc-400 mb-2">
            启用的 Skills ({enabledCount}/{library.skills.length}):
          </div>
          <div className="flex flex-wrap gap-1.5">
            {visibleSkills.map((skill) => (
              <SkillCheckbox
                key={skill.name}
                skill={skill}
                onToggle={onToggleSkill}
                disabled={isUpdating || isRemoving}
              />
            ))}
            {hasMore && !expanded && (
              <button
                onClick={() => setExpanded(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700 transition-colors"
              >
                +{library.skills.length - 5} 更多
                <ChevronDown className="w-3 h-3" />
              </button>
            )}
            {hasMore && expanded && (
              <button
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700 transition-colors"
              >
                收起
                <ChevronUp className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-zinc-800/30 border-t border-zinc-700/50 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onUpdate(library.repoId)}
          loading={isUpdating}
          leftIcon={!isUpdating ? <RefreshCw className="w-3 h-3" /> : undefined}
          disabled={isRemoving}
        >
          更新
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRemove(library.repoId)}
          loading={isRemoving}
          leftIcon={!isRemoving ? <Trash2 className="w-3 h-3" /> : undefined}
          disabled={isUpdating}
          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
        >
          删除
        </Button>
      </div>
    </div>
  );
};

interface RecommendedRepoCardProps {
  repo: SkillRepository;
  onInstall: (repo: SkillRepository) => void;
  isInstalling: boolean;
}

const RecommendedRepoCard: React.FC<RecommendedRepoCardProps> = ({
  repo,
  onInstall,
  isInstalling,
}) => {
  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Package className="w-5 h-5 text-blue-400 shrink-0" />
        <div>
          <h4 className="text-sm font-medium text-zinc-100">{repo.name}</h4>
          {repo.description && (
            <p className="text-xs text-zinc-400 mt-0.5">{repo.description}</p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="primary"
        onClick={() => onInstall(repo)}
        loading={isInstalling}
        leftIcon={!isInstalling ? <Plus className="w-3 h-3" /> : undefined}
      >
        安装
      </Button>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SkillsSettings: React.FC = () => {
  // State
  const [libraries, setLibraries] = useState<LocalSkillLibrary[]>([]);
  const [recommendedRepos, setRecommendedRepos] = useState<SkillRepository[]>([]);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const libs = await invokeSkillIPC<LocalSkillLibrary[]>(SKILL_CHANNELS.REPO_LIST);
      const repos = await invokeSkillIPC<SkillRepository[]>(SKILL_CHANNELS.RECOMMENDED_REPOS);
      setLibraries(libs || []);
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

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">Skills 管理</h3>
        <p className="text-xs text-zinc-400">
          管理已安装的 Skill 库，启用或禁用单个 Skill。
        </p>
      </div>

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

      {/* Installed Libraries */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-100">
          已安装的 Skill 库 ({libraries.length})
        </h4>
        {libraries.length === 0 ? (
          <div className="bg-zinc-800/50 rounded-lg p-6 text-center">
            <Package className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">还没有安装任何 Skill 库</p>
            <p className="text-xs text-zinc-500 mt-1">
              从下方推荐列表安装，或添加自定义仓库
            </p>
          </div>
        ) : (
          libraries.map((library) => (
            <LibraryCard
              key={library.repoId}
              library={library}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              onToggleSkill={handleToggleSkill}
              isUpdating={actionLoading === library.repoId}
              isRemoving={actionLoading === `remove-${library.repoId}`}
            />
          ))
        )}
      </div>

      {/* Recommended Repos */}
      {recommendedRepos.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-zinc-100">推荐安装</h4>
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

      {/* Add Custom Repository */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-100">添加自定义 Skill 库</h4>
        <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-4">
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
              onClick={handleAddCustom}
              loading={actionLoading === 'custom'}
              leftIcon={!actionLoading ? <Plus className="w-3 h-3" /> : undefined}
              disabled={!customUrl.trim()}
            >
              添加仓库
            </Button>
          </div>
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">关于 Skills</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Skills 是预定义的工作流，可以帮助 Agent 更高效地完成特定任务。
          启用的 Skills 会在相关场景下自动推荐使用。
          你可以从官方仓库安装 Skills，也可以添加社区或自定义的 Skill 库。
        </p>
        <a
          href="https://github.com/anthropics/claude-code/tree/main/skills"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mt-2 text-xs text-blue-400 hover:text-blue-300"
        >
          了解如何创建 Skill
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
};
