// ============================================================================
// GeneralSettings - General Application Settings Tab
// Safety Mode Configuration + Timeout Configuration
// ============================================================================

import React, { useState, useEffect } from 'react';
import { CheckCircle, Shield, ShieldOff, ShieldAlert, Clock, Info } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AppSettings } from '@shared/types';

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

// 超时复杂度类型
type TimeoutComplexity = 'simple' | 'medium' | 'complex';

// 默认超时配置
const DEFAULT_TIMEOUTS = {
  simple: 30000,    // 30 秒
  medium: 120000,   // 2 分钟
  complex: 600000,  // 10 分钟
};

export const GeneralSettings: React.FC = () => {
  const { t } = useI18n();

  // 权限模式状态
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [isLoadingPermission, setIsLoadingPermission] = useState(true);

  // 超时配置状态
  const [timeoutComplexity, setTimeoutComplexity] = useState<TimeoutComplexity>('medium');
  const [customTimeout, setCustomTimeout] = useState<number | null>(null);
  const [isLoadingTimeout, setIsLoadingTimeout] = useState(true);

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

  // 加载超时配置
  useEffect(() => {
    const loadTimeoutConfig = async () => {
      try {
        const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET) as AppSettings;
        if (settings?.timeouts) {
          setTimeoutComplexity(settings.timeouts.complexity || 'medium');
          if (settings.timeouts.custom) {
            setCustomTimeout(settings.timeouts.custom);
          }
        }
      } catch (error) {
        console.error('Failed to load timeout config:', error);
      } finally {
        setIsLoadingTimeout(false);
      }
    };
    loadTimeoutConfig();
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

  // 更改超时复杂度
  const handleTimeoutChange = async (complexity: TimeoutComplexity) => {
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        timeouts: {
          complexity,
          simple: DEFAULT_TIMEOUTS.simple,
          medium: DEFAULT_TIMEOUTS.medium,
          complex: DEFAULT_TIMEOUTS.complex,
          custom: customTimeout,
        },
      } as Partial<AppSettings>);
      setTimeoutComplexity(complexity);
    } catch (error) {
      console.error('Failed to save timeout config:', error);
    }
  };

  // 获取当前超时值（毫秒转秒）
  const getCurrentTimeoutSeconds = () => {
    if (customTimeout) return Math.round(customTimeout / 1000);
    return Math.round(DEFAULT_TIMEOUTS[timeoutComplexity] / 1000);
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

      {/* Timeout Configuration */}
      <div className="pt-4 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-100 mb-2 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          API 超时设置
        </h3>
        <p className="text-xs text-zinc-500 mb-4">
          根据任务复杂度调整 API 超时时间，复杂任务需要更长的等待时间
        </p>

        {isLoadingTimeout ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {([
                { id: 'simple', label: '简单', desc: '30 秒', tip: '快速问答、简单修改' },
                { id: 'medium', label: '中等', desc: '2 分钟', tip: '代码生成、文件操作' },
                { id: 'complex', label: '复杂', desc: '10 分钟', tip: '大型重构、深度分析' },
              ] as const).map((option) => {
                const isActive = timeoutComplexity === option.id;

                return (
                  <button
                    key={option.id}
                    onClick={() => handleTimeoutChange(option.id)}
                    className={`p-3 rounded-lg border text-center transition-all duration-200 ${
                      isActive
                        ? 'border-primary-500/50 bg-primary-500/10'
                        : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600 hover:bg-zinc-800/50'
                    }`}
                  >
                    <div
                      className={`text-sm font-medium ${
                        isActive ? 'text-zinc-100' : 'text-zinc-300'
                      }`}
                    >
                      {option.label}
                    </div>
                    <div className={`text-xs mt-1 ${isActive ? 'text-primary-400' : 'text-zinc-500'}`}>
                      {option.desc}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 提示信息 */}
            <div className="flex items-start gap-2 p-2 rounded bg-zinc-800/50">
              <Info className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
              <p className="text-xs text-zinc-400">
                当前超时：<span className="text-zinc-300">{getCurrentTimeoutSeconds()} 秒</span>
                <br />
                <span className="text-zinc-500">
                  {timeoutComplexity === 'simple' && '适用于：快速问答、简单代码修改'}
                  {timeoutComplexity === 'medium' && '适用于：代码生成、文件操作、中等分析任务'}
                  {timeoutComplexity === 'complex' && '适用于：大型重构、架构分析、多文件操作'}
                </span>
              </p>
            </div>
          </>
        )}
      </div>

    </div>
  );
};
