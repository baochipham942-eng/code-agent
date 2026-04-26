// 评测中心专用奶酪图标，跟 EvalCenter 入口一组
import React from 'react';

export const CheeseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 12l10-9 10 9" />
    <path d="M2 12h20v9H2z" />
    <circle cx="7" cy="16" r="1.5" fill="currentColor" />
    <circle cx="12" cy="14" r="1" fill="currentColor" />
    <circle cx="16" cy="17" r="1.5" fill="currentColor" />
  </svg>
);
