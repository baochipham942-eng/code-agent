import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 左侧状态圆点的颜色类（如 bg-emerald-300）；省略则不渲染圆点 */
  dot?: string;
  /** data-* 透传（调用点用它挂 E2E/诊断锚点） */
  [dataAttr: `data-${string}`]: unknown;
}

/**
 * 展示型徽标 pill（收敛自 StatusBar/设置页/知识面板等处的手搓 span）。
 * 结构基类固定为 `inline-flex items-center gap-1 rounded border px-1.5 py-0.5`，
 * 色调（border/bg/text）与尺寸微调（text-[10px]/font-medium 等）由 className 追加。
 */
export const Badge: React.FC<BadgeProps> = ({ className = '', dot, children, ...rest }) => (
  <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${className}`} {...rest}>
    {dot ? <span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> : null}
    {children}
  </span>
);
