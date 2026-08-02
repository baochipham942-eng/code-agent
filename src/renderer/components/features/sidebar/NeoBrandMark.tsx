// ============================================================================
// NeoBrandMark —— 侧栏顶部的 Neo 品牌标识（图形标 + 可选文字标）。
// ============================================================================
// 视觉 = N2 星芒：深空渐变圆角砖 + 直笔 N（青渐变描边）+ 收笔右上四点星芒，
// 外加一圈静态轨道环。规格与 src-tauri/icons/agent-neo.svg、
// src/renderer/assets/brand/ 下的三个标准变体同源（48×48 viewBox）。
// 品牌色是固定字面色（深空砖在任何主题下都是深色底），不随 --brand-primary
// 派生——这是与旧版「color-mix 派生」的有意差异，由品牌规范拍板。
// 轨道环默认静态；animatedOrbit 开启后环上多一颗卫星点 6s/圈，
// prefers-reduced-motion 时 CSS 侧自动停转（global.css .neo-orbit-satellite）。

import React from 'react';

interface NeoBrandMarkProps {
  /** 图形标边长（px），默认 22 —— 侧栏头部 h-12 下的视觉平衡值 */
  size?: number;
  /** 是否显示 "Neo" 文字标 */
  showWordmark?: boolean;
  /** 开启轨道环卫星点动效（6s/圈；prefers-reduced-motion 下自动停转） */
  animatedOrbit?: boolean;
  className?: string;
}

export const NeoBrandMark: React.FC<NeoBrandMarkProps> = ({
  size = 22,
  showWordmark = true,
  animatedOrbit = false,
  className = '',
}) => {
  // 渐变/辉光 defs id 必须按实例唯一：侧栏与欢迎页可同时挂两个标
  const uid = React.useId().replace(/:/g, '');
  const brickId = `neo-brick-${uid}`;
  const glyphId = `neo-glyph-${uid}`;

  return (
    <span className={`flex items-center gap-2 ${className}`} data-testid="neo-brand-mark">
      {/* ds-allow:start 品牌图形标按规范使用固定字面品牌色（深空砖 + 星芒青渐变），与主题 token 解耦是有意决策 */}
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={brickId} x1="8" y1="8" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#16423f" />
            <stop offset="1" stopColor="#0b2422" />
          </linearGradient>
          <linearGradient id={glyphId} x1="10" y1="10" x2="38" y2="38" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7DF9E8" />
            <stop offset="1" stopColor="#14B8A6" />
          </linearGradient>
        </defs>
        {/* 深空砖 */}
        <rect x="2" y="2" width="44" height="44" rx="11" fill={`url(#${brickId})`} stroke="#2dd4bf" strokeOpacity="0.3" strokeWidth="1" />
        {/* 顶部内高光 */}
        <rect x="4" y="3" width="40" height="1.5" rx="0.75" fill="#ffffff" fillOpacity="0.09" />
        {/* N2 星芒字形 */}
        <path
          d="M15 33.5 V14.5 L33 33.5 V14.5"
          stroke={`url(#${glyphId})`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M37 6.5 L38.1 10 L41.6 11.1 L38.1 12.2 L37 15.7 L35.9 12.2 L32.4 11.1 L35.9 10 Z"
          fill="#A7F3D0"
        />
        {/* 轨道环（默认静态） */}
        <circle cx="24" cy="24" r="27" stroke="#5eead4" strokeOpacity="0.34" strokeWidth="1" />
        {/* 动效卫星点：2px 核心 + 辉光晕，绕砖心（viewBox 中心）旋转 */}
        {animatedOrbit && (
          <g className="neo-orbit-satellite">
            <circle cx="43.1" cy="4.9" r="2.4" fill="#A0DCFF" fillOpacity="0.9" opacity="0.35" />
            <circle cx="43.1" cy="4.9" r="1" fill="#E0F2FE" />
          </g>
        )}
      </svg>
      {/* ds-allow:end */}
      {showWordmark && (
        <span className="text-[15px] font-semibold tracking-[-0.015em] text-zinc-100">Neo</span>
      )}
    </span>
  );
};
