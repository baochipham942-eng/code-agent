import React, { useEffect, useMemo } from 'react';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';

interface AgentChipProps {
  onOpenAgentCommand: () => void;
}

export const AgentChip: React.FC<AgentChipProps> = ({ onOpenAgentCommand }) => {
  const { t } = useI18n();
  const entries = useAgentRegistryStore((s) => s.entries);
  const isLoaded = useAgentRegistryStore((s) => s.isLoaded);
  const refresh = useAgentRegistryStore((s) => s.refresh);
  const activeAgentId = useAppStore((s) => s.activeAgentId);

  useEffect(() => {
    if (!isLoaded) {
      void refresh();
    }
  }, [isLoaded, refresh]);

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === activeAgentId) ?? null,
    [activeAgentId, entries],
  );

  // 默认 agent（未显式 /agent 切换）不占位，避免底栏常驻 "Explorer / Agent" 噪音。
  // 用户可通过 /agent 命令切换；切换后才显示当前 agent chip。
  if (!activeEntry) {
    return null;
  }

  const label = activeEntry.name;

  return (
    <button
      type="button"
      data-testid="chat-input-agent-chip"
      onClick={onOpenAgentCommand}
      // 底栏这一行最该先看到的是"在跟谁协作"：头像 + 花名走主位权重（zinc-100/sm），
      // 权限档、上下文环、模型芯片都比它弱一档。之前四样东西同权重并排，
      // 用户读不出哪个是人、哪个是设置。
      className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg px-1.5 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/[0.06]"
      title={`${t.agentCommand.chipTitlePrefix}${activeEntry.profession ? `${activeEntry.name}（${activeEntry.profession}）` : activeEntry.name}${t.agentCommand.chipTitleSuffix}`}
      aria-label={t.agentCommand.chipAriaLabel}
    >
      <RoleInitialAvatar
        roleId={activeEntry.id}
        name={activeEntry.name}
        className="h-5 w-5 text-[10px]"
      />
      {/* 花名是主体不许被挤没，职业先 truncate——用户只看花名不知道这专家是干什么的 */}
      <span className="shrink-0">{label}</span>
      {activeEntry.profession && (
        <span className="min-w-0 truncate text-[10px] font-normal text-zinc-500">{activeEntry.profession}</span>
      )}
    </button>
  );
};
