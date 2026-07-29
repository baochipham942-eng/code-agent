import React, { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';

interface AgentChipProps {
  onOpenAgentCommand: () => void;
}

// Delete/Backspace 与能力 chip、文件 chip 对齐：chip 聚焦后键盘可删
function isChipRemoveKey(event: React.KeyboardEvent): boolean {
  return event.key === 'Delete' || event.key === 'Backspace';
}

export const AgentChip: React.FC<AgentChipProps> = ({ onOpenAgentCommand }) => {
  const { t } = useI18n();
  const entries = useAgentRegistryStore((s) => s.entries);
  const isLoaded = useAgentRegistryStore((s) => s.isLoaded);
  const refresh = useAgentRegistryStore((s) => s.refresh);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setActiveAgentId = useAppStore((s) => s.setActiveAgentId);

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
  // 删除 = 恢复默认路由（setActiveAgentId(null)），与能力 chip 的 × 同一语义
  const removeAgent = () => setActiveAgentId(null);

  return (
    // chip 本体只承载展示/打开面板与焦点：删除收敛到 hover 浮现的 × 按钮与键盘
    // Delete/Backspace（2026-07-29 与 SelectedCapabilityChips 统一的 chip 交互）。
    <div
      role="group"
      tabIndex={0}
      data-testid="chat-input-agent-chip-group"
      aria-label={t.agentCommand.chipAriaLabel}
      onKeyDown={(event) => {
        if (!isChipRemoveKey(event)) return;
        event.preventDefault();
        removeAgent();
      }}
      className="group inline-flex h-8 max-w-[260px] items-center gap-0.5 rounded-lg pr-1 transition-colors hover:bg-white/[0.06]"
    >
      <button
        type="button"
        tabIndex={-1}
        data-testid="chat-input-agent-chip"
        onClick={onOpenAgentCommand}
        // 底栏这一行最该先看到的是"在跟谁协作"：头像 + 花名走主位权重（zinc-100/sm），
        // 权限档、上下文环、模型芯片都比它弱一档。之前四样东西同权重并排，
        // 用户读不出哪个是人、哪个是设置。
        className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg px-1.5 text-sm font-medium text-zinc-100"
        title={`${t.agentCommand.chipTitlePrefix}${activeEntry.profession ? `${activeEntry.name}（${activeEntry.profession}）` : activeEntry.name}${t.agentCommand.chipTitleSuffix}`}
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
      <button
        type="button"
        tabIndex={-1}
        data-testid="chat-input-agent-chip-remove"
        onClick={removeAgent}
        aria-label={t.agentCommand.chipRemoveAria.replace('{name}', activeEntry.name)}
        className="shrink-0 rounded-full p-0.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-600/70 hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
};
