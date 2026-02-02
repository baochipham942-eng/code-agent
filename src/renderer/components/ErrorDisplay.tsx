// ============================================================================
// ErrorDisplay - 统一错误展示组件
// 显示友好的错误消息和恢复建议
// ============================================================================

import React from 'react';
import { AlertCircle, AlertTriangle, Info, XCircle, RefreshCw, Settings, HelpCircle } from 'lucide-react';
import { ErrorCode, ErrorSeverity, type SerializedError } from '../../main/errors/types';

// ============================================================================
// Types
// ============================================================================

export interface ErrorDisplayProps {
  /** 错误对象 */
  error: SerializedError | Error | string;
  /** 自定义标题 */
  title?: string;
  /** 是否显示详细信息（技术细节） */
  showDetails?: boolean;
  /** 是否显示恢复建议 */
  showSuggestion?: boolean;
  /** 重试回调 */
  onRetry?: () => void;
  /** 打开设置回调 */
  onOpenSettings?: () => void;
  /** 关闭回调 */
  onDismiss?: () => void;
  /** 紧凑模式 */
  compact?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeError(error: SerializedError | Error | string): {
  message: string;
  userMessage: string;
  suggestion?: string;
  severity: ErrorSeverity;
  code?: ErrorCode;
  recoverable: boolean;
} {
  if (typeof error === 'string') {
    return {
      message: error,
      userMessage: error,
      severity: ErrorSeverity.ERROR,
      recoverable: false,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      userMessage: error.message,
      severity: ErrorSeverity.ERROR,
      recoverable: true,
    };
  }

  // SerializedError
  return {
    message: error.message,
    userMessage: error.userMessage || error.message,
    suggestion: error.recoverySuggestion,
    severity: error.severity || ErrorSeverity.ERROR,
    code: error.code,
    recoverable: error.recoverable ?? true,
  };
}

function getSeverityConfig(severity: ErrorSeverity) {
  switch (severity) {
    case ErrorSeverity.INFO:
      return {
        icon: Info,
        bgColor: 'bg-blue-500/10',
        borderColor: 'border-blue-500/20',
        iconColor: 'text-blue-400',
        textColor: 'text-blue-300',
      };
    case ErrorSeverity.WARNING:
      return {
        icon: AlertTriangle,
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/20',
        iconColor: 'text-amber-400',
        textColor: 'text-amber-300',
      };
    case ErrorSeverity.CRITICAL:
      return {
        icon: XCircle,
        bgColor: 'bg-red-500/15',
        borderColor: 'border-red-500/30',
        iconColor: 'text-red-400',
        textColor: 'text-red-300',
      };
    case ErrorSeverity.ERROR:
    default:
      return {
        icon: AlertCircle,
        bgColor: 'bg-red-500/10',
        borderColor: 'border-red-500/20',
        iconColor: 'text-red-400',
        textColor: 'text-red-300',
      };
  }
}

function shouldShowSettingsButton(code?: ErrorCode): boolean {
  if (!code) return false;
  return [
    ErrorCode.API_KEY_INVALID,
    ErrorCode.CONFIG_INVALID,
    ErrorCode.CONFIG_MISSING,
    ErrorCode.HOOK_CONFIG_INVALID,
  ].includes(code);
}

// ============================================================================
// Component
// ============================================================================

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error,
  title,
  showDetails = false,
  showSuggestion = true,
  onRetry,
  onOpenSettings,
  onDismiss,
  compact = false,
  className = '',
}) => {
  const normalized = normalizeError(error);
  const config = getSeverityConfig(normalized.severity);
  const Icon = config.icon;
  const showSettings = shouldShowSettingsButton(normalized.code) && onOpenSettings;

  if (compact) {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-lg ${config.bgColor} ${config.borderColor} border ${className}`}
        role="alert"
      >
        <Icon className={`w-4 h-4 shrink-0 ${config.iconColor}`} />
        <span className={`text-sm ${config.textColor}`}>{normalized.userMessage}</span>
        {normalized.recoverable && onRetry && (
          <button
            onClick={onRetry}
            className="ml-auto p-1 rounded hover:bg-white/10 transition-colors"
            aria-label="重试"
          >
            <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg ${config.bgColor} ${config.borderColor} border overflow-hidden ${className}`}
      role="alert"
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className={`p-2 rounded-lg ${config.bgColor}`}>
          <Icon className={`w-5 h-5 ${config.iconColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          {title && (
            <h4 className={`font-medium ${config.textColor} mb-1`}>{title}</h4>
          )}
          <p className="text-sm text-zinc-300">{normalized.userMessage}</p>

          {/* Recovery Suggestion */}
          {showSuggestion && normalized.suggestion && (
            <div className="mt-3 flex items-start gap-2 p-2 rounded bg-zinc-800/50">
              <HelpCircle className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
              <p className="text-xs text-zinc-400">{normalized.suggestion}</p>
            </div>
          )}

          {/* Technical Details */}
          {showDetails && normalized.message !== normalized.userMessage && (
            <details className="mt-3">
              <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                技术详情
              </summary>
              <pre className="mt-2 p-2 rounded bg-zinc-900/50 text-xs text-zinc-500 overflow-x-auto">
                {normalized.message}
              </pre>
            </details>
          )}
        </div>

        {/* Dismiss button */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            aria-label="关闭"
          >
            <XCircle className="w-4 h-4 text-zinc-500" />
          </button>
        )}
      </div>

      {/* Actions */}
      {(onRetry || showSettings) && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-800/50 bg-zinc-900/30">
          {normalized.recoverable && onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重试
            </button>
          )}
          {showSettings && (
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              打开设置
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ErrorDisplay;
