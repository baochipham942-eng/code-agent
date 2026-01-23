// ============================================================================
// PermissionHeader - 权限对话框头部组件
// ============================================================================

import React from 'react';
import { X, AlertTriangle } from 'lucide-react';
import type { PermissionConfig } from './types';

interface PermissionHeaderProps {
  config: PermissionConfig;
  toolName: string;
  isDangerous: boolean;
  onClose: () => void;
}

export function PermissionHeader({
  config,
  toolName,
  isDangerous,
  onClose,
}: PermissionHeaderProps) {
  return (
    <div
      className={`
        flex items-center justify-between
        px-4 py-3
        ${isDangerous ? 'bg-red-900/30' : config.bgColor}
        border-b border-zinc-700
        rounded-t-lg
      `}
    >
      <div className="flex items-center gap-3">
        {/* 图标 */}
        <span
          className={`
            p-2 rounded-lg
            ${isDangerous ? 'bg-red-500/20 text-red-400' : `${config.bgColor} ${config.color}`}
          `}
        >
          {isDangerous ? <AlertTriangle size={20} /> : config.icon}
        </span>

        {/* 标题 */}
        <div>
          <div
            className={`
              text-sm font-medium
              ${isDangerous ? 'text-red-400' : config.color}
            `}
          >
            {isDangerous ? '危险操作' : config.title}
          </div>
          <div className="text-xs text-zinc-400">{toolName}</div>
        </div>
      </div>

      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        aria-label="关闭"
      >
        <X size={18} />
      </button>
    </div>
  );
}
