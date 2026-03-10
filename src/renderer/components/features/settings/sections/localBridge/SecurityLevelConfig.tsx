// ============================================================================
// SecurityLevelConfig - Bridge Security Level Configuration
// ============================================================================

import React from 'react';
import { Shield } from 'lucide-react';
import { useLocalBridgeStore } from '../../../../../stores/localBridgeStore';

// ============================================================================
// Component
// ============================================================================

export const SecurityLevelConfig: React.FC = () => {
  const { securityConfirmL2, setSecurityConfirmL2 } = useLocalBridgeStore();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-4 h-4 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-200">安全权限</span>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <span className="text-sm text-zinc-200">L2 写入操作需确认</span>
          <p className="text-xs text-zinc-500">文件写入、命令执行等操作需要用户手动确认</p>
        </div>
        <button
          onClick={() => setSecurityConfirmL2(!securityConfirmL2)}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            securityConfirmL2 ? 'bg-indigo-500' : 'bg-zinc-600'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              securityConfirmL2 ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </label>

      <div className="bg-zinc-800 rounded-lg p-3 text-xs text-zinc-400 space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="text-green-400 font-medium flex-shrink-0">L1 只读</span>
          <span>文件读取、目录浏览、搜索 — 自动执行</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-yellow-400 font-medium flex-shrink-0">L2 写入</span>
          <span>文件编辑、创建、删除 — 可配置确认</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-red-400 font-medium flex-shrink-0">L3 系统</span>
          <span>命令执行、进程管理 — 始终确认</span>
        </div>
      </div>
    </div>
  );
};
