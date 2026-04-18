// ============================================================================
// Skills - Display mounted skills for current session
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Plus, Minus, Settings } from 'lucide-react';
import { useSkillStore } from '../../stores/skillStore';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { useWorkbenchCapabilityRegistry } from '../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchInsights } from '../../hooks/useWorkbenchInsights';
import { useWorkbenchCapabilityQuickActionRunner } from '../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { WorkbenchCapabilityDetailButton, WorkbenchLabelStack } from './WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../workbench/WorkbenchCapabilitySheetLite';
import {
  formatWorkbenchSkillSecondaryText,
  getWorkbenchCapabilityTitle,
} from '../../utils/workbenchPresentation';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../utils/workbenchCapabilitySheet';

export const Skills: React.FC = () => {
  const { t } = useI18n();
  const { openSettingsTab } = useAppStore();
  const { skills } = useWorkbenchCapabilityRegistry();
  const { history } = useWorkbenchInsights();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const {
    loading,
    mountSkill,
    unmountSkill,
  } = useSkillStore();

  const [expanded, setExpanded] = useState(true);
  const [showAvailable, setShowAvailable] = useState(false);
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  const mountedSkills = skills.filter((skill) => skill.lifecycle.mountState === 'mounted');
  const availableSkills = skills.filter((skill) =>
    skill.lifecycle.installState === 'installed' && skill.lifecycle.mountState === 'unmounted',
  );
  const activeSheetCapability = useMemo(
    () => resolveWorkbenchCapabilityFromSources({
      target: activeSheetTarget,
      primaryItems: skills,
    }),
    [activeSheetTarget, skills],
  );
  const activeSheetHistory = useMemo(
    () => activeSheetTarget ? findWorkbenchCapabilityHistoryItem(history, activeSheetTarget) : null,
    [activeSheetTarget, history],
  );

  // 挂载 skill
  const handleMount = async (skillName: string) => {
    const skill = availableSkills.find((s) => s.id === skillName);
    if (skill) {
      const libraryId = skill.libraryId || skill.source || 'unknown';
      await mountSkill(skillName, libraryId);
    }
  };

  // 打开设置
  const handleOpenSettings = () => {
    openSettingsTab('skills');
  };

  const openCapabilitySheet = useCallback((skillId: string) => {
    setActiveSheetTarget({
      kind: 'skill',
      id: skillId,
    });
  }, []);

  return (
    <>
      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center w-full"
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Sparkles className="w-4 h-4 text-purple-400 flex-shrink-0" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              {t.taskPanel.skills}
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
            {mountedSkills.length === 0 ? (
              <div className="text-xs text-zinc-500 py-1">
                {t.taskPanel.noSkills}
              </div>
            ) : (
              <div className="space-y-1">
                {mountedSkills.map((skill) => {
                  const secondary = formatWorkbenchSkillSecondaryText(skill, { locale: 'zh' });
                  return (
                    <div
                      key={skill.id}
                      className="flex items-center justify-between gap-2 py-1 px-2 bg-zinc-800 rounded group"
                      title={skill.description || skill.label}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Sparkles className="w-3 h-3 text-purple-400/70 flex-shrink-0" />
                        <WorkbenchLabelStack
                          label={skill.label}
                          secondary={secondary}
                          title={skill.description || skill.label}
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <WorkbenchCapabilityDetailButton
                          label={skill.label}
                          onClick={() => openCapabilitySheet(skill.id)}
                        />
                        <button
                          onClick={() => unmountSkill(skill.id)}
                          disabled={loading}
                          className="p-0.5 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                          title={t.taskPanel.unmountSkill}
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {availableSkills.length > 0 && (
              <div className="pt-1 border-t border-white/[0.04]">
                <button
                  onClick={() => setShowAvailable(!showAvailable)}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>{t.taskPanel.addSkills.replace('{count}', String(availableSkills.length))}</span>
                </button>

                {showAvailable && (
                  <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                    {availableSkills.slice(0, 8).map((skill) => {
                      const secondary = formatWorkbenchSkillSecondaryText(skill, { locale: 'zh' });
                      return (
                        <div key={skill.id} className="flex items-center gap-1">
                          <button
                            onClick={() => handleMount(skill.id)}
                            disabled={loading}
                            className="flex-1 flex items-center gap-2 py-1 px-2 text-left hover:bg-zinc-800 rounded transition-colors"
                            title={getWorkbenchCapabilityTitle(skill, { locale: 'zh' })}
                          >
                            <Plus className="w-3 h-3 text-zinc-500" />
                            <WorkbenchLabelStack
                              label={skill.label}
                              secondary={secondary}
                              title={getWorkbenchCapabilityTitle(skill, { locale: 'zh' })}
                              labelClassName="text-xs text-zinc-400 truncate"
                            />
                          </button>
                          <WorkbenchCapabilityDetailButton
                            label={skill.label}
                            onClick={() => openCapabilitySheet(skill.id)}
                          />
                        </div>
                      );
                    })}
                    {availableSkills.length > 8 && (
                      <div className="text-xs text-zinc-500 text-center py-1">
                        +{availableSkills.length - 8} {t.taskPanel.more}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleOpenSettings}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors pt-1"
            >
              <Settings className="w-3 h-3" />
              <span>{t.taskPanel.manageSkills}</span>
            </button>
          </div>
        )}
      </div>

      <WorkbenchCapabilitySheetLite
        isOpen={Boolean(activeSheetCapability)}
        capability={activeSheetCapability}
        historyItem={activeSheetHistory}
        runningActionKey={runningActionKey}
        actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
        completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
        onQuickAction={runQuickAction}
        onClose={() => setActiveSheetTarget(null)}
      />
    </>
  );
};
