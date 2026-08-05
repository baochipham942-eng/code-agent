// ============================================================================
// RailTabShell —— 右栏共享壳：顶部横滑 tab 条 + 全高内容区（批P 返工第二波）。
// 参照 WorkBuddy 右栏：tab 条贴顶、溢出横滑（overflow-x-auto scrollbar-none）、
// 内容区拿全高。tab 条样式制度的唯一真源是 WorkbenchTabs（对齐 FileExplorerPanel
// TabBar：rounded-t 小 tab / active bg-zinc-800 / 图标 3.5 / hover 态），壳从它抽出，
// 避免空间右栏与正常会话右栏两份 tab 条样式漂移。
// 壳只管布局与 tab 切换语义（role=tablist/tab、aria-selected、Enter/Space、min-w-0
// 横滑链）；tab 集合、右端动作（＋/收起钮）、弹层、内容区全由调用方注入。
// 消费方：正常会话右栏 WorkbenchTabs、空间右栏 ProjectConfigRail。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2, type LucideIcon } from 'lucide-react';
import { IconButton } from '../primitives/IconButton';

export interface RailTabItem {
  id: string;
  label: string;
  /** 悬浮提示（workbench 预览 tab 给完整路径）；缺省不落 title 属性 */
  title?: string;
  icon?: LucideIcon;
  iconClassName?: string;
  /**
   * 动态图标 URL（浏览器 favicon）。有值时优先渲染 img；
   * 加载失败自动回落 Lucide icon（Globe 等）。
   */
  iconSrc?: string | null;
  testId?: string;
  /** label 之后的内嵌内容（脏点/关闭 × 等）；交互事件自理 stopPropagation */
  suffix?: React.ReactNode;
}

const RailTabIcon: React.FC<{
  icon?: LucideIcon;
  iconSrc?: string | null;
  iconClassName?: string;
}> = ({ icon: Icon, iconSrc, iconClassName }) => {
  const [failed, setFailed] = useState(false);
  // URL 变化时重置失败态，避免上一页 favicon 失败把新页一起挡住
  useEffect(() => {
    setFailed(false);
  }, [iconSrc]);

  if (iconSrc && !failed) {
    return (
      <img
        src={iconSrc}
        alt=""
        aria-hidden
        data-testid="rail-tab-favicon"
        className="h-3.5 w-3.5 flex-shrink-0 rounded-sm object-contain"
        onError={() => setFailed(true)}
      />
    );
  }
  if (!Icon) return null;
  return <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${iconClassName ?? ''}`} />;
};

export interface RailTabShellProps {
  tabs: RailTabItem[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  /** tablist 的无障碍称谓 */
  ariaLabel: string;
  /** 条容器 testid（overlay 弹层也挂在这个 relative 容器里） */
  testId?: string;
  /** 内容区 testid（探针量「内容区拿全高」用） */
  contentTestId?: string;
  /** 条容器 ref（调用方做弹层外点关闭等） */
  stripRef?: React.Ref<HTMLDivElement>;
  /** tab 条右端动作区（＋/收起钮）；两态开关住同一位置，不随状态搬家 */
  trailing?: React.ReactNode;
  /**
   * 专注模式（2026-08-01 工单①）：给了 onToggleFocus 就在条右端画专注开关——
   * 一个按钮、一个位置、两个状态（侧栏态 Maximize2 / 专注态 Minimize2，只换图标不搬家，
   * 2026-07-27 房规）。Esc 退出专注态由壳统一接管。布局效果（聊天列收起）由调用方消费。
   * 用开关就必须给两态称谓（IconButton 强制 aria-label；渲染处对 focusLabel 判空兜底）。
   */
  focused?: boolean;
  onToggleFocus?: () => void;
  focusEnterLabel?: string;
  focusExitLabel?: string;
  /** 绝对定位弹层（＋菜单），渲染在条容器内、tablist 之外 */
  overlay?: React.ReactNode;
  /** 全高内容区；滚动/留白由调用方内容自己决定 */
  children?: React.ReactNode;
}

export const RailTabShell: React.FC<RailTabShellProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  ariaLabel,
  testId,
  contentTestId,
  stripRef,
  trailing,
  focused = false,
  onToggleFocus,
  focusEnterLabel,
  focusExitLabel,
  overlay,
  children,
}) => {
  // Esc 退出专注态（只在专注态挂监听；侧栏态的 Esc 不归壳管）
  useEffect(() => {
    if (!focused || !onToggleFocus) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onToggleFocus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focused, onToggleFocus]);

  const focusLabel = focused ? focusExitLabel : focusEnterLabel;

  return (
  <div className="flex h-full min-h-0 flex-col">
    <div
      ref={stripRef}
      data-testid={testId}
      className="relative flex shrink-0 items-center gap-1 border-b border-zinc-700 bg-zinc-900 px-2 py-1.5"
    >
      {/* tab 条：min-w-0 + overflow-x-auto 横滑链（窄窗前科：宽内容在自身容器内滚，不撑宽页面） */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              data-testid={tab.testId}
              title={tab.title}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelectTab(tab.id);
              }}
              className={`group flex max-w-[140px] cursor-pointer items-center gap-1.5 rounded-t px-2 py-1 text-xs transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`}
            >
              <RailTabIcon
                icon={tab.icon}
                iconSrc={tab.iconSrc}
                iconClassName={tab.iconClassName}
              />
              <span className="truncate">{tab.label}</span>
              {tab.suffix}
            </div>
          );
        })}
        {trailing}
      </div>
      {/* 专注开关：条右端固定槽位，两态同住一个位置（只换图标/称谓，不搬家）。
          focusLabel 判空兜底：有开关必须有称谓（IconButton 强制 aria-label）。 */}
      {onToggleFocus && focusLabel && (
        <IconButton
          size="sm"
          variant="ghost"
          data-testid="rail-tab-shell-focus-toggle"
          icon={focused ? <Minimize2 /> : <Maximize2 />}
          aria-label={focusLabel}
          aria-pressed={focused}
          title={focusLabel}
          onClick={onToggleFocus}
          className="flex-shrink-0"
        />
      )}
      {overlay}
    </div>
    <div data-testid={contentTestId} className="min-h-0 min-w-0 flex-1">
      {children}
    </div>
  </div>
  );
};
