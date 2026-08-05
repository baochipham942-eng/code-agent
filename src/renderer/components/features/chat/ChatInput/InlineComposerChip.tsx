// ============================================================================
// InlineComposerChip - 文字流内联 chip（WorkBuddy phrase chip 模型）
// ============================================================================
//
// chip 是 composerStore / attachments 的渲染，不是数据源：
// - command → composerStore.pendingCommand（teal + 命令图标，复用 PendingCommandChip 配色）
// - skill   → composerStore.selectedSkillIds（zinc pill + emerald sparkle，同 SelectedCapabilityChips）
// - file    → attachments（zinc pill + 文件类型图标，同 AttachmentBar）
// 删除入口：hover 浮现 ×、chip 聚焦后 Delete/Backspace（onRemove → 对应 store 移除 →
// InputArea 的对账 effect 摘除 DOM 挂载点）。Backspace 紧贴 chip 的删除在 InputArea 键处理里。
//
// 渲染方式：React portal 进 contenteditable=false 的 DOM 挂载点（见 composerRichTextModel）。

import { BookOpen, Sparkles, Target, X } from 'lucide-react';
import type { AttachmentCategory } from '../../../../../shared/contract';
import { useI18n } from '../../../../hooks/useI18n';
import { AttachmentIcon } from './AttachmentBar';
import { COMMAND_ICONS } from './PendingCommandChip';
import type { InlineChipKind } from './composerRichTextModel';

export interface InlineChipView {
  /** `${kind}:${id}`，与 DOM 挂载点 / store 条目对账 */
  key: string;
  kind: InlineChipKind;
  id: string;
  label: string;
  /** kind=file 时的附件类别（决定图标） */
  category?: AttachmentCategory;
}

export function InlineComposerChip({
  chip,
  onRemove,
}: {
  chip: InlineChipView;
  onRemove: (chip: InlineChipView) => void;
}) {
  const { t } = useI18n();

  const removeAria = chip.kind === 'command'
    ? t.pendingCommand.removeAria.replace('{name}', chip.label)
    : chip.kind === 'skill'
      ? t.selectedCapabilityChips.removeAria.replace('{name}', chip.label)
      : chip.kind === 'library'
        ? t.library.pinnedChipRemoveAria.replace('{title}', chip.label)
        : t.chatInput.attachRemoveAria.replace('{name}', chip.label);

  const palette = chip.kind === 'command'
    ? 'border-badge-accent/30 bg-fuchsia-500/10 text-badge-accent hover:border-badge-accent/50'
    : chip.kind === 'library'
      ? 'border-badge-accent/30 bg-indigo-500/10 text-badge-accent hover:border-badge-accent/50'
      : 'border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:border-zinc-500';
  const closeHover = chip.kind === 'command'
    ? 'text-badge-accent hover:bg-fuchsia-400/20 hover:text-badge-accent'
    : 'text-zinc-400 hover:bg-zinc-600/70 hover:text-zinc-100';

  const CommandIcon = chip.kind === 'command' ? (COMMAND_ICONS[chip.id] ?? Target) : null;

  return (
    <span
      role="group"
      tabIndex={0}
      aria-label={chip.label}
      data-inline-chip={chip.kind}
      onKeyDown={(event) => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        event.preventDefault();
        onRemove(chip);
      }}
      className={`group mx-px inline-flex max-w-[220px] cursor-default select-none items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline text-xs transition-colors ${palette}`}
    >
      {chip.kind === 'command' && CommandIcon ? (
        <CommandIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : chip.kind === 'skill' ? (
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-badge-success" aria-hidden />
      ) : chip.kind === 'library' ? (
        <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <AttachmentIcon category={chip.category ?? 'document'} className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">{chip.label}</span>
      <button /* ds-allow:button: chip 删除是图标级小按钮，Button primitive 无此紧凑图标变体 */
        type="button"
        tabIndex={-1}
        onClick={() => onRemove(chip)}
        aria-label={removeAria}
        className={`-mr-0.5 shrink-0 rounded-full p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${closeHover}`}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}
