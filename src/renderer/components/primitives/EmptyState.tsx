import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * 空态视觉变体——逐一对应迁移前各调用点的既有形态（视觉保真，不新造样式）：
 * - box    : 虚线边框卡片，仅文本（原 PluginsSettings 局部定义）
 * - panel  : 虚线边框面板，图标+标题+文本（原 KnowledgeMemoryPanel.parts 局部定义）
 * - plain  : 无边框居中，图标+标题+文本（原 PlanningPanel 局部定义）
 * - inline : 单行浅色文本（原 TaskPanel/Card 的 CardEmptyState）
 */
export type EmptyStateVariant = 'box' | 'panel' | 'plain' | 'inline';

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  icon?: LucideIcon;
  title?: React.ReactNode;
  text: React.ReactNode;
}

// ponytail: 变体=既有调用点形态的枚举，不开放自由 className；出现第 5 种形态时先想想能不能归并进这 4 种
export const EmptyState: React.FC<EmptyStateProps> = ({ variant = 'box', icon: Icon, title, text }) => {
  switch (variant) {
    case 'inline':
      return <div className="text-xs text-zinc-600 py-1">{text}</div>;
    case 'panel':
      return (
        <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 px-6 text-center">
          {Icon && <Icon className="h-8 w-8 text-zinc-600" />}
          {title && <h4 className="mt-3 text-sm font-medium text-zinc-300">{title}</h4>}
          <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">{text}</p>
        </div>
      );
    case 'plain':
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
          {Icon && <Icon className="w-12 h-12 text-zinc-600 mb-3" />}
          {title && <p className="text-sm text-zinc-400">{title}</p>}
          <p className="text-xs text-zinc-500 mt-1">{text}</p>
        </div>
      );
    case 'box':
    default:
      return (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/35 px-4 py-6 text-center text-sm text-zinc-500">
          {text}
        </div>
      );
  }
};
