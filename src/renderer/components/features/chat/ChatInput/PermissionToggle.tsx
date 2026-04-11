// ============================================================================
// PermissionToggle - 全局权限模式切换
// Default (锁定) / Full Access (自动批准所有权限)
// ============================================================================

import React, { useState, useCallback } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { usePermissionStore, type PermissionMode } from '../../../../stores/permissionStore';

// ============================================================================
// Props
// ============================================================================

interface PermissionToggleProps {
  disabled?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export const PermissionToggle: React.FC<PermissionToggleProps> = ({ disabled }) => {
  const globalMode = usePermissionStore((s) => s.globalMode);
  const setGlobalMode = usePermissionStore((s) => s.setGlobalMode);
  const [showConfirm, setShowConfirm] = useState(false);

  const isFullAccess = globalMode === 'full_access';

  const handleClick = useCallback(() => {
    if (isFullAccess) {
      // Switching back to default: no confirmation needed
      setGlobalMode('default');
      setShowConfirm(false);
    } else {
      // Switching to full access: show confirmation
      setShowConfirm(true);
    }
  }, [isFullAccess, setGlobalMode]);

  const handleConfirm = useCallback(() => {
    setGlobalMode('full_access');
    setShowConfirm(false);
  }, [setGlobalMode]);

  const handleCancel = useCallback(() => {
    setShowConfirm(false);
  }, []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={isFullAccess ? '全权限模式: 自动批准所有请求' : '默认模式: 逐个审批权限'}
        className={`
          flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium
          transition-all duration-150
          ${isFullAccess
            ? 'bg-red-500/20 text-red-400'
            : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.04]'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        {isFullAccess ? (
          <LockOpen className="w-3 h-3" />
        ) : (
          <Lock className="w-3 h-3" />
        )}
        <span>{isFullAccess ? 'Full Access' : 'Default'}</span>
      </button>

      {/* Confirmation popover */}
      {showConfirm && (
        <div className="absolute bottom-full right-0 mb-2 w-56 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-20 p-3">
          <p className="text-xs text-zinc-300 mb-3">
            将自动批准所有权限请求，包括文件写入和命令执行。
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
            >
              确认开启
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
