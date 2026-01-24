// ============================================================================
// SkillsPanel - 会话级 Skill 管理面板
// 右侧面板，用于挂载/卸载当前会话的 Skills
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import {
  X,
  Plus,
  Minus,
  Search,
  Settings,
  RefreshCw,
  Sparkles,
  Package,
  AlertCircle,
} from 'lucide-react';
import { useSkillStore } from '../stores/skillStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import type { SessionSkillMount } from '@shared/types/skillRepository';
import type { ParsedSkill } from '@shared/types/agentSkill';

// ----------------------------------------------------------------------------
// Props
// ----------------------------------------------------------------------------

interface SkillsPanelProps {
  onClose: () => void;
}

// ----------------------------------------------------------------------------
// Sub Components
// ----------------------------------------------------------------------------

interface MountedSkillItemProps {
  mount: SessionSkillMount;
  skill?: ParsedSkill;
  onUnmount: () => void;
  loading?: boolean;
}

const MountedSkillItem: React.FC<MountedSkillItemProps> = ({
  mount,
  skill,
  onUnmount,
  loading,
}) => (
  <div className="flex items-center justify-between px-2 py-1.5 bg-zinc-800/50 rounded group">
    <div className="flex-1 min-w-0">
      <div className="text-sm text-zinc-200 truncate">{mount.skillName}</div>
      {skill && (
        <div className="text-xs text-zinc-500 truncate">{skill.description}</div>
      )}
      <div className="text-xs text-zinc-600 truncate">
        {mount.libraryId}
      </div>
    </div>
    <button
      onClick={onUnmount}
      disabled={loading}
      className="p-1 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      title="卸载"
    >
      <Minus className="w-3.5 h-3.5" />
    </button>
  </div>
);

interface AvailableSkillItemProps {
  skill: ParsedSkill;
  onMount: () => void;
  loading?: boolean;
}

const AvailableSkillItem: React.FC<AvailableSkillItemProps> = ({
  skill,
  onMount,
  loading,
}) => (
  <div className="flex items-center justify-between px-2 py-1.5 hover:bg-zinc-800/50 rounded group">
    <div className="flex-1 min-w-0">
      <div className="text-sm text-zinc-300 truncate">{skill.name}</div>
      <div className="text-xs text-zinc-500 truncate">{skill.description}</div>
    </div>
    <button
      onClick={onMount}
      disabled={loading}
      className="p-1 text-zinc-500 hover:text-green-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      title="挂载"
    >
      <Plus className="w-3.5 h-3.5" />
    </button>
  </div>
);

// ----------------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------------

export const SkillsPanel: React.FC<SkillsPanelProps> = ({ onClose }) => {
  const { currentSessionId } = useSessionStore();
  const { setShowSettings } = useAppStore();
  const {
    mountedSkills,
    availableSkills,
    loading,
    error,
    setCurrentSession,
    fetchAvailableSkills,
    mountSkill,
    unmountSkill,
    refreshAll,
    clearError,
  } = useSkillStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 初始化：设置当前会话并加载数据
  useEffect(() => {
    if (currentSessionId) {
      setCurrentSession(currentSessionId);
      fetchAvailableSkills();
    }
  }, [currentSessionId, setCurrentSession, fetchAvailableSkills]);

  // 过滤未挂载的可用 skills
  const unmountedSkills = useMemo(() => {
    const mountedNames = new Set(mountedSkills.map((m) => m.skillName));
    return availableSkills.filter((s) => !mountedNames.has(s.name));
  }, [availableSkills, mountedSkills]);

  // 搜索过滤
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return unmountedSkills;
    const query = searchQuery.toLowerCase();
    return unmountedSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query)
    );
  }, [unmountedSkills, searchQuery]);

  // 挂载 skill
  const handleMount = async (skill: ParsedSkill) => {
    // 从 basePath 推断 libraryId
    // basePath 格式通常是: /path/to/libraries/{libraryId}/skills/{skillName}
    const pathParts = skill.basePath.split('/');
    const librariesIndex = pathParts.findIndex((p) => p === 'libraries' || p === 'skills');
    let libraryId = 'unknown';
    if (librariesIndex >= 0 && pathParts[librariesIndex + 1]) {
      libraryId = pathParts[librariesIndex + 1];
    } else {
      // 回退：使用 source 或倒数第二个路径部分
      libraryId = skill.source || pathParts[pathParts.length - 2] || 'unknown';
    }
    await mountSkill(skill.name, libraryId);
  };

  // 卸载 skill
  const handleUnmount = async (skillName: string) => {
    await unmountSkill(skillName);
  };

  // 刷新
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshAll();
    setIsRefreshing(false);
  };

  // 打开设置
  const handleOpenSettings = () => {
    setShowSettings(true);
    onClose();
  };

  // 清除错误
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => clearError(), 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  return (
    <div className="w-72 border-l border-zinc-800 bg-zinc-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-400" />
          Session Skills
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || loading}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw
              className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
            />
          </button>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 bg-red-900/20 border-b border-red-800/50 flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* 当前挂载 */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">
            当前挂载 ({mountedSkills.length})
          </h4>

          {mountedSkills.length === 0 ? (
            <div className="text-xs text-zinc-500 py-2 flex items-center gap-2">
              <Package className="w-4 h-4 opacity-50" />
              暂无挂载的 Skills
            </div>
          ) : (
            <div className="space-y-1">
              {mountedSkills.map((mount) => (
                <MountedSkillItem
                  key={mount.skillName}
                  mount={mount}
                  skill={availableSkills.find((s) => s.name === mount.skillName)}
                  onUnmount={() => handleUnmount(mount.skillName)}
                  loading={loading}
                />
              ))}
            </div>
          )}
        </div>

        {/* 分隔线 */}
        <div className="border-t border-zinc-800 my-2" />

        {/* 快速添加 */}
        <div className="px-3 py-2">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">快速添加</h4>

          {/* 搜索框 */}
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索 skill..."
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
            />
          </div>

          {/* 可用 Skills 列表 */}
          {availableSkills.length === 0 ? (
            <div className="text-xs text-zinc-500 py-2">
              {loading ? '加载中...' : '暂无可用 Skills'}
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="text-xs text-zinc-500 py-2">
              {searchQuery ? '未找到匹配的 Skill' : '所有 Skills 已挂载'}
            </div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {filteredSkills.slice(0, 10).map((skill) => (
                <AvailableSkillItem
                  key={skill.name}
                  skill={skill}
                  onMount={() => handleMount(skill)}
                  loading={loading}
                />
              ))}
              {filteredSkills.length > 10 && (
                <div className="text-xs text-zinc-500 py-1 text-center">
                  还有 {filteredSkills.length - 10} 个...
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部 */}
      <div className="px-3 py-2 border-t border-zinc-800">
        <button
          onClick={handleOpenSettings}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 rounded transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          在设置中管理 Skill 库
        </button>
      </div>
    </div>
  );
};

export default SkillsPanel;
