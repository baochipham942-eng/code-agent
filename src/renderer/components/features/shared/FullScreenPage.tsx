// ============================================================================
// FullScreenPage / FullScreenPageHeader - 二级页面统一外壳
//
// 外壳契约（与设置页同范式，参照 Codex 设置页）：
// - 整窗接管：全屏 fixed 覆盖层，底色 bg-zinc-900 与主窗口内容区同层（不再用更深的
//   zinc-950 造成明暗层级颠倒），进场统一 animate-fadeIn 淡入。
// - header 与主 TitleBar 对齐：同为 h-12，且不声明 WebkitAppRegion 拖拽区
//   （TitleBar 本身也不是 drag region）。
// - 关闭范式统一为左上角「← 返回应用」（复用 i18n key settings.backToApp，
//   不再各页自传 closeLabel / 右上角 X）；title 紧随其后，右侧仅保留页面级
//   actions 插槽。
// ============================================================================
import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

interface FullScreenPageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  testId?: string;
}

interface FullScreenPageHeaderProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
}

export const FullScreenPage: React.FC<FullScreenPageProps> = ({
  children,
  className = '',
  testId,
  ...divProps
}) => (
  <div
    {...divProps}
    data-testid={testId}
    className={`fixed inset-0 z-50 flex min-h-0 flex-col bg-zinc-900 text-zinc-100 animate-fadeIn ${className}`}
  >
    {children}
  </div>
);

export const FullScreenPageHeader: React.FC<FullScreenPageHeaderProps> = ({
  icon,
  title,
  description,
  badge,
  actions,
  onClose,
}) => {
  const { t } = useI18n();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-muted bg-zinc-900 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 focus:outline-hidden"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>{t.settings.backToApp}</span>
        </button>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/70 bg-zinc-800">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold text-zinc-100">{title}</h2>
            {badge}
          </div>
          {description ? <p className="mt-0.5 truncate text-xs text-zinc-500">{description}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {actions}
      </div>
    </header>
  );
};
