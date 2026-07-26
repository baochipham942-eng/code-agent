// ============================================================================
// PageContent / PageCard - 二级页面外壳内的第一级布局契约
//
// 与 FullScreenPage 配套（2026-07-27 UX 收尾 1.4，二级页内部布局收敛）：
// - 宽度二选一：full（全宽，默认）/ centered（居中 max-w-6xl，卡片堆叠类页面）。
//   centered 由内层包裹实现，滚动容器仍是整宽，滚动条贴窗口边缘。
// - padding 统一 px-6 py-4；页内工具行/状态条等横带对齐同一横向节奏（px-6）。
//   全 bleed 工作台页（列表+详情双栏、嵌入画布、tab 内自管布局）用
//   padding={false} 放行，由页内面板自管内边距。
// - scroll 默认 true（overflow-y-auto）；false 时转为 flex 容器（overflow-hidden），
//   供内部面板自管滚动高度的页面使用。
// - PageCard 统一卡片语言：rounded-lg border border-zinc-800 bg-zinc-900/70，
//   可选 header（icon + title + actions）+ body（默认 p-4，bodyClassName 可覆盖）。
// ============================================================================
import React from 'react';

export type PageContentWidth = 'full' | 'centered';

export interface PageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: PageContentWidth;
  scroll?: boolean;
  padding?: boolean;
  /** width="centered" 时内层 max-w-6xl 包裹的附加类（如 gap-4） */
  innerClassName?: string;
  testId?: string;
}

export const PageContent: React.FC<PageContentProps> = ({
  width = 'full',
  scroll = true,
  padding = true,
  innerClassName = '',
  className = '',
  testId,
  children,
  ...divProps
}) => {
  const containerClass = `min-h-0 flex-1 ${scroll ? 'overflow-y-auto' : 'flex flex-col overflow-hidden'} ${padding ? 'px-6 py-4' : ''} ${className}`;
  if (width === 'centered') {
    return (
      <div {...divProps} data-testid={testId} className={containerClass}>
        <div className={`mx-auto flex w-full max-w-6xl flex-col ${innerClassName}`}>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div {...divProps} data-testid={testId} className={containerClass}>
      {children}
    </div>
  );
};

// Omit<'title'>：HTMLAttributes 的 title 是 string tooltip，这里 title 是卡片标题节点
export interface PageCardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  bodyClassName?: string;
  testId?: string;
}

export const PageCard: React.FC<PageCardProps> = ({
  title,
  icon,
  actions,
  bodyClassName = 'p-4',
  className = '',
  testId,
  children,
  ...sectionProps
}) => (
  <section
    {...sectionProps}
    data-testid={testId}
    className={`rounded-lg border border-zinc-800 bg-zinc-900/70 ${className}`}
  >
    {(title || actions) ? (
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        {icon ? <div className="text-zinc-500">{icon}</div> : null}
        {title ? <h2 className="text-sm font-medium text-zinc-100">{title}</h2> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
    ) : null}
    <div className={bodyClassName}>{children}</div>
  </section>
);
