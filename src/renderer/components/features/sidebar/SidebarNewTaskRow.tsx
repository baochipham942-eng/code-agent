import React from 'react';
import { ChevronRight, Loader2, Plus } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

interface SidebarNewTaskRowProps {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
}

export const SidebarNewTaskRow: React.FC<SidebarNewTaskRowProps> = ({
  onClick,
  disabled,
  loading,
}) => {
  const { t } = useI18n();
  const sb = t.sidebar;

  return (
    <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={sb.newTaskTitle}
      data-testid="sidebar-new-task"
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-cyan-500/10">
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400/90" />
        ) : (
          <Plus className="h-3.5 w-3.5 text-cyan-400/90" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {sb.newTask}
        </span>
        <span className="block truncate text-[11px] text-zinc-500">{sb.newTaskSubtitle}</span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
    </button>
  );
};
