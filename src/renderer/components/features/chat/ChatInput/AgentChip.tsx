import React, { useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';

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
      onClick={onOpenAgentCommand}
      className={`
        inline-flex h-8 max-w-[200px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium
        transition-colors
        ${activeEntry
          ? 'text-amber-300 hover:bg-amber-500/10 hover:text-amber-200'
          : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'}
      `}
      title={`${t.agentCommand.chipTitlePrefix}${activeEntry.profession ? `${activeEntry.name}（${activeEntry.profession}）` : activeEntry.name}${t.agentCommand.chipTitleSuffix}`}
      aria-label={t.agentCommand.chipAriaLabel}
    >
      <Bot className="h-3.5 w-3.5 shrink-0" />
      {/* 花名是主体不许被挤没，职业先 truncate——用户只看花名不知道这专家是干什么的 */}
      <span className="shrink-0">{label}</span>
      {activeEntry.profession && (
        <span className="min-w-0 truncate text-[10px] font-normal opacity-70">{activeEntry.profession}</span>
      )}
    </button>
  );
};
