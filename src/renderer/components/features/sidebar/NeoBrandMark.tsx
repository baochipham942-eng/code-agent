// ============================================================================
// NeoBrandMark —— 侧栏顶部的 Neo 品牌标识（图形标 + 可选文字标）。
// ============================================================================
// 配色全部由 --brand-primary 经 color-mix 派生，不写死任何 hex：
//   * 字形 = 全色品牌 → 对比度靠设计系统已保证的 brand-contrast（四套主题均达标）
//   * 底色 = 品牌 18% 透明 + 42% 描边环 → 给小尺寸足够存在感，又不吃掉字形对比
// 实测过 dark / 高对比深色 / 高对比浅色 三套主题与 16/20/24/28px 四档尺寸。
// 曾试过「实心品牌底 + 挖空字形」，在高对比浅色（品牌=深蓝）下字形几乎不可见——
// CSS 无法按亮度分支选挖空色，故改用「低透底 + 全色字形」，靠背景对比天然成立。

import React from 'react';

interface NeoBrandMarkProps {
  /** 图形标边长（px），默认 22 —— 侧栏头部 h-12 下的视觉平衡值 */
  size?: number;
  /** 是否显示 "Neo" 文字标 */
  showWordmark?: boolean;
  className?: string;
}

export const NeoBrandMark: React.FC<NeoBrandMarkProps> = ({
  size = 22,
  showWordmark = true,
  className = '',
}) => (
  <span className={`flex items-center gap-2 ${className}`} data-testid="neo-brand-mark">
    {/* ds-allow:start 品牌图形标在 16/20/24/28px 四档实测采用 7px 圆角，通用 radius token 会改变已验视觉比例 */}
    <span
      className="flex flex-shrink-0 items-center justify-center rounded-[7px]"
      style={{
        width: size,
        height: size,
        color: 'var(--brand-primary)',
        background: 'color-mix(in srgb, var(--brand-primary) 18%, transparent)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brand-primary) 42%, transparent)',
      }}
    >
      <svg
        width={Math.round(size * 0.64)}
        height={Math.round(size * 0.64)}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        {/* 单笔连续的 N：起笔上行、斜下、收笔上行，圆角端点让 16px 下仍不糊 */}
        <path
          d="M7.6 17.4V8.2c0-1.05 1.3-1.53 1.98-.72l5.44 6.52c.68.81 1.98.33 1.98-.72V6.6"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
    {/* ds-allow:end */}
    {showWordmark && (
      <span className="text-[15px] font-semibold tracking-[-0.015em] text-zinc-100">Neo</span>
    )}
  </span>
);
