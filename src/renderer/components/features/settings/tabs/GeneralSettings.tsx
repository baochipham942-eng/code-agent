// ============================================================================
// GeneralSettings - General Application Settings Tab
// Safety Mode Configuration
// ============================================================================

import React, { useState, useEffect } from 'react';
import { CheckCircle, Shield, ShieldOff, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';

// 权限模式类型
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

interface SafetyModeOption {
  id: PermissionMode;
  icon: React.ReactNode;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
}

// ============================================================================
// Component
// ============================================================================

export const GeneralSettings: React.FC = () => {
  const { t } = useI18n();

  // 权限模式状态
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [isLoadingPermission, setIsLoadingPermission] = useState(true);

  // 加载当前权限模式
  useEffect(() => {
    const loadPermissionMode = async () => {
      try {
        const currentMode = await window.electronAPI?.invoke(IPC_CHANNELS.PERMISSION_GET_MODE);
        if (currentMode && ['default', 'acceptEdits', 'bypassPermissions'].includes(currentMode)) {
          setPermissionMode(currentMode as PermissionMode);
        }
      } catch (error) {
        console.error('Failed to load permission mode:', error);
      } finally {
        setIsLoadingPermission(false);
      }
    };
    loadPermissionMode();
  }, []);

  // 更改权限模式
  const handlePermissionModeChange = async (newMode: PermissionMode) => {
    try {
      const success = await window.electronAPI?.invoke(IPC_CHANNELS.PERMISSION_SET_MODE, newMode);
      if (success) {
        setPermissionMode(newMode);
      }
    } catch (error) {
      console.error('Failed to set permission mode:', error);
    }
  };

  // 安全模式选项
  const safetyModeOptions: SafetyModeOption[] = [
    {
      id: 'default',
      icon: <Shield className="w-5 h-5" />,
      title: '安全模式',
      description: '执行写入、命令、网络操作前需要确认',
      riskLevel: 'low',
    },
    {
      id: 'acceptEdits',
      icon: <ShieldAlert className="w-5 h-5" />,
      title: '自动编辑',
      description: '自动接受文件编辑，其他操作需要确认',
      riskLevel: 'medium',
    },
    {
      id: 'bypassPermissions',
      icon: <ShieldOff className="w-5 h-5" />,
      title: 'YOLO 模式',
      description: '跳过所有权限检查，适合可信环境',
      riskLevel: 'high',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Safety Mode Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">
          安全模式
        </h3>
        <p className="text-xs text-zinc-500 mb-4">
          控制 Agent 执行敏感操作时的权限检查行为
        </p>

        {isLoadingPermission ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {safetyModeOptions.map((option) => {
              const isActive = permissionMode === option.id;
              const riskColors = {
                low: { border: 'border-green-500/50', bg: 'bg-green-500/10', text: 'text-green-400' },
                medium: { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-400' },
                high: { border: 'border-red-500/50', bg: 'bg-red-500/10', text: 'text-red-400' },
              };
              const colors = riskColors[option.riskLevel];

              return (
                <button
                  key={option.id}
                  onClick={() => handlePermissionModeChange(option.id)}
                  className={`relative p-3 rounded-lg border text-left transition-all duration-200 ${
                    isActive
                      ? `${colors.border} ${colors.bg}`
                      : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600 hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        isActive ? `${colors.bg} ${colors.text}` : 'bg-zinc-700/50 text-zinc-400'
                      }`}
                    >
                      {option.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4
                          className={`text-sm font-medium ${
                            isActive ? 'text-zinc-100' : 'text-zinc-300'
                          }`}
                        >
                          {option.title}
                        </h4>
                        {isActive && (
                          <CheckCircle className={`w-4 h-4 ${colors.text}`} />
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {option.description}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* YOLO Mode Warning */}
        {permissionMode === 'bypassPermissions' && (
          <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="flex items-start gap-2">
              <ShieldOff className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-medium text-red-300">YOLO 模式已启用</h4>
                <p className="text-xs text-red-400/70 mt-1">
                  所有权限检查已跳过。Agent 可以直接执行文件写入、命令执行等操作，请确保在可信环境中使用。
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};
