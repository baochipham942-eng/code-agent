import React from 'react';
import { Loader2, SquarePen } from 'lucide-react';
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
      data-testid="sidebar-new-task"
      className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {/* 与能力区三行同一形态：裸图标 + 文字（2026-07-26 打磨批 D D1）。
          品牌瓦片（色块图标容器）与能力中心/资料库/自动化是两种语言，产品负责人
          真机点名突兀；主次改靠字色表达——新任务是侧栏第一主动作，文字用
          zinc-100 + medium，其余入口行保持 zinc-300。 */}
      {loading ? (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-zinc-500" />
      ) : (
        <SquarePen className="h-4 w-4 flex-shrink-0 text-zinc-500" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
        {sb.newTask}
      </span>
    </button>
  );
};
