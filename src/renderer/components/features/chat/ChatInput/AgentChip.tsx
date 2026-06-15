import React, { useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { useAppStore } from '../../../../stores/appStore';

interface AgentChipProps {
  onOpenAgentCommand: () => void;
}

export const AgentChip: React.FC<AgentChipProps> = ({ onOpenAgentCommand }) => {
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
  const label = activeEntry?.name || 'Agent';

  return (
    <button
      type="button"
      onClick={onOpenAgentCommand}
      className={`
        inline-flex h-8 max-w-[150px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium
        transition-colors
        ${activeEntry
          ? 'text-amber-300 hover:bg-amber-500/10 hover:text-amber-200'
          : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'}
      `}
      title={activeEntry ? `当前 agent: ${activeEntry.name}。输入 /agent 切换。` : '输入 /agent 切换 agent'}
      aria-label="当前 agent"
    >
      <Bot className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
};
