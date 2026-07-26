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
    <button /* ds-allow:button: 侧栏入口区单行列表行（图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={sb.newTaskTitle}
      data-testid="sidebar-new-task"
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {/* ds-allow:start 品牌瓦片与 NeoBrandMark 同一配方（--brand-primary color-mix 派生）：
          新任务是侧栏第一主动作，全栏只有它挂品牌色；能力区三行一律中性裸图标。
          此前的 cyan 是界面里第六种无关色相，已按品牌化拍板移除。 */}
      <span
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
        style={{
          color: 'var(--brand-primary)',
          background: 'color-mix(in srgb, var(--brand-primary) 18%, transparent)',
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brand-primary) 42%, transparent)',
        }}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </span>
      {/* ds-allow:end */}
      {/* 单行：「开始一段新的协作」这类说明性副标题第一次有用、第一百次是噪音，
          真正有信息量的那句（不继承项目上下文）留在 title 悬浮提示里。 */}
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
        {sb.newTask}
      </span>
      <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
    </button>
  );
};
