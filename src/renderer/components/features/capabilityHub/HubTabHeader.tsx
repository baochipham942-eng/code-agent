// ============================================================================
// HubTabHeader - 能力中心四个 tab 共用的页头（2026-07-27 批 C 审美关尾款）
//
// 布局契约（四 tab 同一套，对标 WorkBuddy，不许一个 tab 一个方案）：
// - 第一行：<h1> 当前 tab 名 + 右侧操作簇（tab 切换 / 刷新 / 新建类动作），
//   flex items-center justify-between 同层对齐；
// - 第二行（可选 children）：次级导航 / 筛选 chips；没有就不渲染、不留空高。
// - 吸顶 + 出血：`sticky -top-4 -mt-4 pt-6` 三件套缺一不可（2026-07-27 从 ExpertPanel
//   移植过来，并入本组件后四个 tab 一起受益）。sticky 的吸附基准是滚动容器的**内容盒**，
//   而 PageContent 带 py-4 —— 只写 top-0 会停在 padding 下沿，上方留 16px 缝隙让卡片
//   从标题和工具条中间穿过去（实测 sticky.top=108 vs 滚动口 92）。负 top 把吸附点提到
//   padding 上沿，负 margin 让静止态也贴顶，自带 pt-6 补回内边距。
//   底色必须**不透明**：bg-zinc-900/95 + backdrop-blur 在滚动时把下方内容透出来，
//   读起来像两段标题串行（2026-07-27 产品负责人两次指出）。
//   -mx-6 px-6 让底边线铺满整宽。底部间距 mb-3：实测四个 tab「页头 → 内容首元素」间距均为 12px
//   （批 C 验收判据 ③，差 0 ≤ 4px）。
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
    className="sticky -top-4 z-10 -mx-6 -mt-4 mb-3 border-b border-zinc-800/70 bg-zinc-900 px-6 pb-2 pt-6"
  >
    <div className="flex items-center justify-between gap-4">
      <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-100">{title}</h1>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    {children ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div> : null}
  </div>
);
