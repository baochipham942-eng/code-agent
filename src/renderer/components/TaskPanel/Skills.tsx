// ============================================================================
// Skills - Display mounted skills for current session
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Plus, Minus, Settings } from 'lucide-react';
import { useSkillStore } from '../../stores/skillStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';

export const Skills: React.FC = () => {
  const { t } = useI18n();
  const { openSettingsTab } = useAppStore();
  const { currentSessionId } = useSessionStore();
  const {
    mountedSkills,
    availableSkills,
    loading,
    setCurrentSession,
    fetchAvailableSkills,
    mountSkill,
    unmountSkill,
  } = useSkillStore();

  const [expanded, setExpanded] = useState(true);
  const [showAvailable, setShowAvailable] = useState(false);

  // 初始化：设置当前会话并加载数据
  useEffect(() => {
    if (currentSessionId) {
      setCurrentSession(currentSessionId);
      fetchAvailableSkills();
    }
  }, [currentSessionId, setCurrentSession, fetchAvailableSkills]);

  // 获取未挂载的可用 skills
  const unmountedSkills = availableSkills.filter(
    (s) => !mountedSkills.some((m) => m.skillName === s.name)
  );

  // 挂载 skill
  const handleMount = async (skillName: string) => {
    const skill = availableSkills.find((s) => s.name === skillName);
    if (skill) {
      // 从 basePath 推断 libraryId
      const pathParts = skill.basePath.split('/');
      const skillsIndex = pathParts.findIndex((p) => p === 'skills');
      const libraryId = skillsIndex >= 0 && pathParts[skillsIndex + 1]
        ? pathParts[skillsIndex + 1]
        : skill.source || 'unknown';
      await mountSkill(skillName, libraryId);
    }
  };

  // 打开设置
  const handleOpenSettings = () => {
    openSettingsTab('skills');
  };

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Sparkles className="w-4 h-4 text-purple-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            Skills
          </span>
          {mountedSkills.length > 0 && (
            <span className="text-xs text-zinc-500">({mountedSkills.length})</span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {/* 已挂载的 Skills */}
          {mountedSkills.length === 0 ? (
            <div className="text-xs text-zinc-500 py-1">
              暂无挂载的 Skills
            </div>
          ) : (
            <div className="space-y-1">
              {mountedSkills.map((mount) => (
                  <div
                    key={mount.skillName}
                    className="flex items-center justify-between py-1 px-2 bg-zinc-800/30 rounded group"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Sparkles className="w-3 h-3 text-purple-400/70 flex-shrink-0" />
                      <span className="text-xs text-zinc-300 truncate">{mount.skillName}</span>
                    </div>
                    <button
                      onClick={() => unmountSkill(mount.skillName)}
                      disabled={loading}
                      className="p-0.5 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                      title="卸载"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                  </div>
              ))}
            </div>
          )}

          {/* 快速添加按钮 */}
          {unmountedSkills.length > 0 && (
            <div className="pt-1 border-t border-white/[0.04]">
              <button
                onClick={() => setShowAvailable(!showAvailable)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <Plus className="w-3 h-3" />
                <span>添加 ({unmountedSkills.length})</span>
              </button>

              {showAvailable && (
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                  {unmountedSkills.slice(0, 8).map((skill) => (
                    <button
                      key={skill.name}
                      onClick={() => handleMount(skill.name)}
                      disabled={loading}
                      className="w-full flex items-center gap-2 py-1 px-2 text-left hover:bg-zinc-800/50 rounded transition-colors"
                    >
                      <Plus className="w-3 h-3 text-zinc-500" />
                      <span className="text-xs text-zinc-400 truncate">{skill.name}</span>
                    </button>
                  ))}
                  {unmountedSkills.length > 8 && (
                    <div className="text-xs text-zinc-500 text-center py-1">
                      +{unmountedSkills.length - 8} 更多
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 管理入口 */}
          <button
            onClick={handleOpenSettings}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors pt-1"
          >
            <Settings className="w-3 h-3" />
            <span>管理 Skill 库</span>
          </button>
        </div>
      )}
    </div>
  );
};
