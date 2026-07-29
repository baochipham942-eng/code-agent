// ============================================================================
// PendingCommandChip - 特色命令 chip（2026-07-29 UX round2 任务 17）
// ============================================================================
//
// /goal /schedule /loop /workflow 选中后挂到 composer chip 区：命令图标 + 中文名，
// teal 色相与 skill 系的 emerald/sparkle chip（NeoContinuationChip）区分开。
// 删除交互与文件/capability/pin chip 统一：hover 浮现 × + chip 聚焦后 Delete/Backspace。
// 真源在 composerStore.pendingCommand，发送时由 useChatInputSubmit 拼回前缀并清掉。

import { Clock3, GitBranch, Repeat, Target, X } from 'lucide-react';
import { useComposerStore } from '../../../../stores/composerStore';
import { useI18n } from '../../../../hooks/useI18n';

// 导出给内联 chip（InlineComposerChip）复用同一套命令图标
export const COMMAND_ICONS: Record<string, typeof Target> = {
  goal: Target,
  schedule: Clock3,
  loop: Repeat,
  workflow: GitBranch,
};

export function PendingCommandChip() {
  const { t } = useI18n();
  const pendingCommand = useComposerStore((state) => state.pendingCommand);
  const setPendingCommand = useComposerStore((state) => state.setPendingCommand);
  if (!pendingCommand) return null;

  const Icon = COMMAND_ICONS[pendingCommand.id] ?? Target;
  const remove = () => setPendingCommand(null);

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-2" data-testid="pending-command-chips">
      <div
        role="group"
        tabIndex={0}
        aria-label={pendingCommand.name}
        onKeyDown={(event) => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') return;
          event.preventDefault();
          remove();
        }}
        className="group inline-flex max-w-[220px] cursor-default items-center gap-1 rounded-full border border-teal-500/30 bg-teal-500/10 px-1.5 py-0.5 text-xs text-teal-200 transition-colors hover:border-teal-400/50"
      >
        <Icon className="h-4 w-4 shrink-0 p-0.5" aria-hidden />
        <span className="truncate">{pendingCommand.name}</span>
        <button
          type="button"
          tabIndex={-1}
          onClick={remove}
          aria-label={t.pendingCommand.removeAria.replace('{name}', pendingCommand.name)}
          className="-mr-0.5 shrink-0 rounded-full p-0.5 text-teal-300 opacity-0 transition-opacity hover:bg-teal-400/20 hover:text-teal-100 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
