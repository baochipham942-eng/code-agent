// ============================================================================
// AlertBanner - 告警横幅组件
// 显示连续错误告警、系统状态等通知
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, X, RefreshCw, Settings, ChevronDown, ChevronUp } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  timestamp: number;
  dismissible?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  details?: string;
}

interface AlertBannerProps {
  alerts: Alert[];
  onDismiss?: (id: string) => void;
  maxVisible?: number;
  className?: string;
}

// ============================================================================
// Helper
// ============================================================================

function getLevelConfig(level: AlertLevel) {
  switch (level) {
    case 'info':
      return {
        bg: 'bg-blue-500/90',
        text: 'text-white',
        icon: 'text-blue-200',
      };
    case 'warning':
      return {
        bg: 'bg-amber-500/90',
        text: 'text-amber-950',
        icon: 'text-amber-800',
      };
    case 'error':
      return {
        bg: 'bg-red-500/90',
        text: 'text-white',
        icon: 'text-red-200',
      };
    case 'critical':
      return {
        bg: 'bg-red-600',
        text: 'text-white',
        icon: 'text-red-200',
      };
  }
}

// ============================================================================
// Single Alert Item
// ============================================================================

interface AlertItemProps {
  alert: Alert;
  onDismiss?: () => void;
}

const AlertItem: React.FC<AlertItemProps> = ({ alert, onDismiss }) => {
  const [showDetails, setShowDetails] = useState(false);
  const config = getLevelConfig(alert.level);

  return (
    <div className={`${config.bg} ${config.text}`}>
      <div className="max-w-screen-xl mx-auto px-4 py-2">
        <div className="flex items-center gap-3">
          <AlertTriangle className={`w-4 h-4 shrink-0 ${config.icon}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{alert.title}</span>
              {alert.details && (
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="p-0.5 rounded hover:bg-white/10 transition-colors"
                >
                  {showDetails ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>
            <p className="text-sm opacity-90">{alert.message}</p>
          </div>

          {/* Action button */}
          {alert.action && (
            <button
              onClick={alert.action.onClick}
              className="px-3 py-1 text-sm rounded bg-white/20 hover:bg-white/30 transition-colors shrink-0"
            >
              {alert.action.label}
            </button>
          )}

          {/* Dismiss button */}
          {alert.dismissible !== false && onDismiss && (
            <button
              onClick={onDismiss}
              className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Expandable details */}
        {showDetails && alert.details && (
          <div className="mt-2 pl-7 text-sm opacity-80">
            <pre className="whitespace-pre-wrap font-mono text-xs bg-black/10 rounded p-2">
              {alert.details}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const AlertBanner: React.FC<AlertBannerProps> = ({
  alerts,
  onDismiss,
  maxVisible = 3,
  className = '',
}) => {
  const [collapsed, setCollapsed] = useState(false);

  if (alerts.length === 0) return null;

  const visibleAlerts = collapsed ? [alerts[0]] : alerts.slice(0, maxVisible);
  const hiddenCount = alerts.length - visibleAlerts.length;

  return (
    <div className={`fixed top-0 left-0 right-0 z-50 ${className}`}>
      {visibleAlerts.map(alert => (
        <AlertItem
          key={alert.id}
          alert={alert}
          onDismiss={onDismiss ? () => onDismiss(alert.id) : undefined}
        />
      ))}

      {/* Show more/less toggle */}
      {alerts.length > 1 && (
        <div className="bg-zinc-800 text-center py-1">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
          >
            {collapsed ? (
              <>显示全部 ({alerts.length} 条告警)</>
            ) : hiddenCount > 0 ? (
              <>还有 {hiddenCount} 条告警</>
            ) : (
              <>收起</>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Error Rate Alert Hook
// 监控连续错误，触发告警
// ============================================================================

export interface UseErrorAlertConfig {
  /** 触发告警的连续错误次数阈值 */
  threshold: number;
  /** 告警重置时间（毫秒） */
  resetTimeout: number;
}

export interface UseErrorAlertReturn {
  /** 当前告警列表 */
  alerts: Alert[];
  /** 记录一次错误 */
  recordError: (error: Error | string) => void;
  /** 记录一次成功（重置计数） */
  recordSuccess: () => void;
  /** 关闭告警 */
  dismissAlert: (id: string) => void;
  /** 清除所有告警 */
  clearAlerts: () => void;
}

export function useErrorAlert(
  config: UseErrorAlertConfig = { threshold: 3, resetTimeout: 60000 }
): UseErrorAlertReturn {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [errorCount, setErrorCount] = useState(0);
  const [lastErrors, setLastErrors] = useState<string[]>([]);

  const recordError = useCallback((error: Error | string) => {
    const message = error instanceof Error ? error.message : error;

    setLastErrors(prev => [...prev.slice(-4), message]); // 保留最近 5 条
    setErrorCount(prev => {
      const newCount = prev + 1;

      // 达到阈值，生成告警
      if (newCount === config.threshold) {
        const alert: Alert = {
          id: `error-rate-${Date.now()}`,
          level: 'error',
          title: '连续错误告警',
          message: `连续 ${newCount} 次操作失败，请检查网络或配置`,
          timestamp: Date.now(),
          dismissible: true,
          action: {
            label: '查看设置',
            onClick: () => {
              // 这里可以触发打开设置的逻辑
            },
          },
          details: lastErrors.join('\n'),
        };

        setAlerts(prev => [alert, ...prev].slice(0, 5));
      }

      return newCount;
    });
  }, [config.threshold, lastErrors]);

  const recordSuccess = useCallback(() => {
    setErrorCount(0);
    setLastErrors([]);
  }, []);

  const dismissAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setErrorCount(0);
    setLastErrors([]);
  }, []);

  // 自动重置计数
  useEffect(() => {
    if (errorCount === 0) return;

    const timer = setTimeout(() => {
      setErrorCount(0);
      setLastErrors([]);
    }, config.resetTimeout);

    return () => clearTimeout(timer);
  }, [errorCount, config.resetTimeout]);

  return {
    alerts,
    recordError,
    recordSuccess,
    dismissAlert,
    clearAlerts,
  };
}

export default AlertBanner;
