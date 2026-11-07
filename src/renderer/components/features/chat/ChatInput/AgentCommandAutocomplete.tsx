import React from 'react';
import { UserPlus } from 'lucide-react';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { useI18n } from '../../../../hooks/useI18n';
import type { AgentCommandOption } from './agentCommand';

/** /agent autocomplete list. Extracted from ChatInput so the god file does not grow. */
export function AgentCommandAutocomplete({
  query,
  options,
  selectedIndex,
  onSelect,
  onDraftCleared,
}: {
  query: string | null;
  options: AgentCommandOption[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onDraftCleared: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto rounded-lg elevation-l2 popover-enter">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        /agent
      </div>
      {/* 任务 15：query echo —— 输入过滤词可见，空 query 给搜索提示 */}
      <div className="border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
        {query?.trim()
          ? t.mentionPanel.searchEcho.replace('{query}', query).replace('{count}', String(options.length))
          : t.mentionPanel.emptyHintAgent}
      </div>
      {options.map((option, index) => (
        <React.Fragment key={option.id ?? 'default'}>
          {option.group === 'role' && options[index - 1]?.group !== 'role' && (
            <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
              {t.agentCommand.roleGroupLabel}
            </div>
          )}
          <button
            type="button"
            onClick={() => onSelect(index)}
            className={`w-full px-3 py-2 text-left transition-colors ${
              index === selectedIndex
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-300 hover:bg-zinc-800/70'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">
                <RoleInitialAvatar roleId={option.id ?? 'default'} name={option.name} className="h-6 w-6 text-[11px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{option.name}</span>
                  {option.profession ? (
                    <span className="shrink-0 truncate text-[10px] text-zinc-500">{option.profession}</span>
                  ) : null}
                  <span className="ml-auto rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                    {option.token}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">
                  {option.description}
                </div>
              </div>
            </div>
          </button>
        </React.Fragment>
      ))}
      {/* 角色名单底部"招新"：对话式建角色入口（role-creation-flow §7） */}
      <button
        type="button"
        onClick={() => {
          onDraftCleared();
          void startCreateRoleChat();
        }}
        className="flex w-full items-center gap-1.5 border-t border-zinc-800 px-3 py-2 text-left text-xs text-badge-success transition-colors hover:bg-emerald-500/10"
      >
        <UserPlus className="h-3.5 w-3.5 shrink-0" />
        {t.agentCommand.createRoleEntry}
      </button>
    </div>
  );
}
