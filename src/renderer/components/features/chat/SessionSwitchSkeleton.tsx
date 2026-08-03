// ============================================================================
// 历史会话切换骨架屏（工单 2026-08-01）：切历史会话时消息投影 hydration 要几秒，
// 空窗期被用户当成「这个会话是空的」。三态分明——加载中（本骨架屏）/ 真空会话
// （#874 的「继续上次的会话」空态）/ 有内容（正常渲染）。
// 出现阈值 150ms：快速切换不闪骨架；hydration 一完成即整体换成真内容，无过渡跳变。
// ============================================================================

import React, { useEffect, useState } from 'react';

/** 骨架屏出现阈值：hydration 在此之内完成则全程不显示，避免快速切换闪一帧。 */
export const SESSION_SKELETON_DELAY_MS = 150;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 单条占位气泡：静态底 + shimmer 扫光（reduced-motion 下只剩静态底，不动）。 */
const SkeletonBubble: React.FC<{ className: string }> = ({ className }) => (
  <div className={`relative overflow-hidden rounded-2xl bg-zinc-800/40 ${className}`}>
    {!prefersReducedMotion() && <div className="animate-shimmer absolute inset-0" />}
  </div>
);

/**
 * 消息区骨架：2-3 条消息形状的占位（左右气泡轮廓）。输入框在骨架屏期间正常可用
 * （composer 不在本组件管辖内）。
 */
export const SessionSwitchSkeleton: React.FC = () => {
  // 延迟可见：挂载后 150ms 内 hydration 就完成了的话，骨架从未上屏即被真内容替换。
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SESSION_SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 px-4 py-6"
      aria-hidden
      data-testid="session-switch-skeleton"
    >
      {/* 左：对方/assistant 气泡轮廓 */}
      <div className="flex justify-start">
        <SkeletonBubble className="h-14 w-2/3" />
      </div>
      {/* 右：我的气泡轮廓 */}
      <div className="flex justify-end">
        <SkeletonBubble className="h-9 w-1/3" />
      </div>
      <div className="flex justify-start">
        <SkeletonBubble className="h-20 w-1/2" />
      </div>
    </div>
  );
};

/**
 * 消息区空分支的三态裁决（ChatView 在 projection.turns 为空时渲染它）：
 * - settled（已确定当前会话且非加载中）→ welcome（#874 空态/欢迎页，调用方传入）
 * - hydration 进行中 → 骨架屏
 * - 冷启动未定会话 → 空白占位（原行为保留，避免闪现默认页）
 */
export const EmptySessionArea: React.FC<{
  isHydratingSession: boolean;
  settled: boolean;
  welcome: React.ReactNode;
}> = ({ isHydratingSession, settled, welcome }) => {
  if (settled) return <>{welcome}</>;
  if (isHydratingSession) return <SessionSwitchSkeleton />;
  return <div className="h-full" aria-hidden />;
};
