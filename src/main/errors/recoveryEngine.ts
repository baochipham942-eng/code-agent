// ============================================================================
// Recovery Engine - Automated error recovery with user notification
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('RecoveryEngine');

export enum RecoveryAction {
  AUTO_RETRY = 'auto_retry',
  OPEN_SETTINGS = 'open_settings',
  AUTO_COMPACT = 'auto_compact',
  AUTO_SWITCH_PROVIDER = 'auto_switch_provider',
  NOTIFY_ONLY = 'notify_only',
}

export interface ErrorRecoveryEvent {
  errorCode: string;
  userMessage: string;
  recoveryAction: RecoveryAction;
  recoveryStatus: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface RecoveryContext {
  onRetry?: () => Promise<void>;
  onCompact?: () => Promise<void>;
  onSwitchProvider?: (fallbackProvider: string) => Promise<void>;
}

interface ErrorPattern {
  test: (error: Error) => boolean;
  action: RecoveryAction;
  userMessage: string | ((error: Error) => string);
  maxRetries?: number;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    test: (e) => e.message.includes('429') || e.message.toLowerCase().includes('rate limit'),
    action: RecoveryAction.AUTO_RETRY,
    userMessage: (e) => {
      const match = e.message.match(/(\d+)\s*s/);
      const seconds = match ? match[1] : '5';
      return `请求过快，${seconds}s 后自动重试`;
    },
    maxRetries: 3,
  },
  {
    test: (e) => e.message.includes('401') || e.message.includes('Unauthorized') || e.message.includes('API key'),
    action: RecoveryAction.OPEN_SETTINGS,
    userMessage: 'API Key 无效，请检查设置',
  },
  {
    test: (e) => e.message.includes('ContextLength') || e.message.includes('context_length') || e.message.includes('maximum context'),
    action: RecoveryAction.AUTO_COMPACT,
    userMessage: '对话过长，正在压缩...',
  },
  {
    test: (e) => e.message.includes('timeout') || e.message.includes('ETIMEDOUT'),
    action: RecoveryAction.AUTO_SWITCH_PROVIDER,
    userMessage: '网络超时，尝试切换模型',
  },
  {
    test: (e) => e.message.includes('ECONNREFUSED') || e.message.includes('ECONNRESET') || e.message.includes('socket hang up'),
    action: RecoveryAction.AUTO_RETRY,
    userMessage: '网络连接失败，正在重试...',
    maxRetries: 2,
  },
  {
    test: (e) => e.message.includes('model_not_available') || e.message.includes('503'),
    action: RecoveryAction.AUTO_SWITCH_PROVIDER,
    userMessage: (e) => {
      const provider = e.message.match(/(\w+)\s*(API|Provider)/i)?.[1] || '模型';
      return `${provider} 异常，已切换到备用模型`;
    },
  },
];

export class RecoveryEngine {
  private retryCounts = new Map<string, number>();

  async handleError(error: Error, context?: RecoveryContext): Promise<ErrorRecoveryEvent> {
    const pattern = ERROR_PATTERNS.find(p => p.test(error));

    if (!pattern) {
      logger.warn(`[RecoveryEngine] No recovery pattern for: ${error.message}`);
      return {
        errorCode: 'UNKNOWN',
        userMessage: `发生错误: ${error.message.substring(0, 100)}`,
        recoveryAction: RecoveryAction.NOTIFY_ONLY,
        recoveryStatus: 'failed',
        timestamp: Date.now(),
      };
    }

    const userMessage = typeof pattern.userMessage === 'function'
      ? pattern.userMessage(error)
      : pattern.userMessage;

    const event: ErrorRecoveryEvent = {
      errorCode: this.classifyError(error),
      userMessage,
      recoveryAction: pattern.action,
      recoveryStatus: 'in_progress',
      timestamp: Date.now(),
    };

    logger.info(`[RecoveryEngine] Handling error: ${event.errorCode} → ${event.recoveryAction}`);

    try {
      switch (pattern.action) {
        case RecoveryAction.AUTO_RETRY: {
          const retryKey = event.errorCode;
          const count = (this.retryCounts.get(retryKey) || 0) + 1;
          this.retryCounts.set(retryKey, count);

          if (count > (pattern.maxRetries || 3)) {
            event.recoveryStatus = 'failed';
            event.userMessage = `重试次数已达上限 (${count}次)`;
            break;
          }

          const delay = Math.min(count * 2000, 10000);
          await new Promise(r => setTimeout(r, delay));

          if (context?.onRetry) {
            await context.onRetry();
            event.recoveryStatus = 'succeeded';
            this.retryCounts.delete(retryKey);
          }
          break;
        }
        case RecoveryAction.AUTO_COMPACT:
          if (context?.onCompact) {
            await context.onCompact();
            event.recoveryStatus = 'succeeded';
          }
          break;
        case RecoveryAction.AUTO_SWITCH_PROVIDER:
          if (context?.onSwitchProvider) {
            await context.onSwitchProvider('zhipu');
            event.recoveryStatus = 'succeeded';
          }
          break;
        case RecoveryAction.OPEN_SETTINGS:
        case RecoveryAction.NOTIFY_ONLY:
          event.recoveryStatus = 'pending';
          break;
      }
    } catch (recoveryError) {
      logger.error(`[RecoveryEngine] Recovery failed:`, recoveryError);
      event.recoveryStatus = 'failed';
    }

    return event;
  }

  private classifyError(error: Error): string {
    const msg = error.message.toLowerCase();
    if (msg.includes('429') || msg.includes('rate limit')) return 'RATE_LIMIT';
    if (msg.includes('401') || msg.includes('unauthorized')) return 'AUTH_ERROR';
    if (msg.includes('context') && msg.includes('length')) return 'CONTEXT_LENGTH';
    if (msg.includes('timeout')) return 'NETWORK_TIMEOUT';
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('socket hang up')) return 'NETWORK_CONNECTION';
    if (msg.includes('503') || msg.includes('model_not_available')) return 'MODEL_UNAVAILABLE';
    return 'UNKNOWN';
  }

  resetRetryCount(errorCode?: string): void {
    if (errorCode) {
      this.retryCounts.delete(errorCode);
    } else {
      this.retryCounts.clear();
    }
  }
}

// Singleton
let instance: RecoveryEngine | null = null;
export function getRecoveryEngine(): RecoveryEngine {
  if (!instance) instance = new RecoveryEngine();
  return instance;
}
