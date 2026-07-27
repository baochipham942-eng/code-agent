// ============================================================================
// HubTabHeader - 能力中心四个 tab 共用的页头（2026-07-27 批 C 审美关尾款）
//
// 布局契约（四 tab 同一套，对标 WorkBuddy，不许一个 tab 一个方案）：
// - 第一行：<h1> 当前 tab 名 + 右侧操作簇（tab 切换 / 刷新 / 新建类动作），
//   flex items-center justify-between 同层对齐；
// - 第二行（可选 children）：次级导航 / 筛选 chips；没有就不渲染、不留空高。
// - 吸顶 + 出血写法沿用 ExpertPanel 工具条（它是对的，保留）：
//   sticky top-0 z-10 -mx-6 px-6 py-2 border-b bg-zinc-900/95 backdrop-blur。
//   滚动容器是 PageContent（overflow-y-auto px-6 py-4），-mx-6 px-6 让底边线
//   铺满整宽。
// ============================================================================
import React from 'react';

interface HubTabHeaderProps {
  title: string;
  /** 第一行右侧操作簇 */
  actions?: React.ReactNode;
  /** 第二行：次级导航 / 筛选 chips；缺省不渲染、不留空高 */
  children?: React.ReactNode;
  testId?: string;
}

export const HubTabHeader: React.FC<HubTabHeaderProps> = ({ title, actions, children, testId }) => (
  <div
    data-testid={testId}
    className="sticky top-0 z-10 -mx-6 mb-3 border-b border-zinc-800/70 bg-zinc-900/95 px-6 py-2 backdrop-blur"
  >
    <div className="flex items-center justify-between gap-4">
      <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-100">{title}</h1>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    {children ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div> : null}
  </div>
);
