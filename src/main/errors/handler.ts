// ============================================================================
// Error Handler - Centralized error handling utilities
// ============================================================================

import {
  CodeAgentError,
  ErrorCode,
  ErrorSeverity,
  ToolError,
  FileSystemError,
  ModelError,
  HookError,
  type SerializedError,
} from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ErrorHandler');

// ----------------------------------------------------------------------------
// Error Normalization
// ----------------------------------------------------------------------------

/**
 * Convert any error to a CodeAgentError
 */
export function normalizeError(error: unknown): CodeAgentError {
  // Already a CodeAgentError
  if (error instanceof CodeAgentError) {
    return error;
  }

  // Standard Error
  if (error instanceof Error) {
    return new CodeAgentError(error.message, {
      cause: error,
      code: inferErrorCode(error),
    });
  }

  // String error
  if (typeof error === 'string') {
    return new CodeAgentError(error);
  }

  // Unknown error
  return new CodeAgentError('An unknown error occurred', {
    context: { originalError: String(error) },
  });
}

/**
 * Infer error code from standard error
 */
function inferErrorCode(error: Error): ErrorCode {
  const message = error.message.toLowerCase();

  // File system errors
  if (message.includes('enoent') || message.includes('not found')) {
    return ErrorCode.FILE_NOT_FOUND;
  }
  if (message.includes('eacces') || message.includes('permission denied')) {
    return ErrorCode.FILE_PERMISSION_DENIED;
  }

  // Network errors
  if (message.includes('timeout')) {
    return ErrorCode.TIMEOUT;
  }
  if (message.includes('econnrefused') || message.includes('connection')) {
    return ErrorCode.API_CONNECTION_FAILED;
  }

  // API errors
  if (message.includes('rate limit')) {
    return ErrorCode.RATE_LIMIT_EXCEEDED;
  }
  if (message.includes('context length') || message.includes('token')) {
    return ErrorCode.CONTEXT_LENGTH_EXCEEDED;
  }
  if (message.includes('api key') || message.includes('unauthorized')) {
    return ErrorCode.API_KEY_INVALID;
  }

  return ErrorCode.UNKNOWN;
}

// ----------------------------------------------------------------------------
// Error Recovery
// ----------------------------------------------------------------------------

/**
 * Recovery strategy for different error types
 */
export interface RecoveryStrategy {
  /** Should retry the operation */
  shouldRetry: boolean;
  /** Delay before retry in ms */
  retryDelay?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Fallback action to take */
  fallback?: 'ignore' | 'notify' | 'abort';
  /** Message to show user */
  userMessage?: string;
}

/**
 * Get recovery strategy for an error
 */
export function getRecoveryStrategy(error: CodeAgentError): RecoveryStrategy {
  switch (error.code) {
    case ErrorCode.TIMEOUT:
    case ErrorCode.API_CONNECTION_FAILED:
      return {
        shouldRetry: true,
        retryDelay: 1000,
        maxRetries: 3,
        fallback: 'notify',
      };

    case ErrorCode.RATE_LIMIT_EXCEEDED:
      return {
        shouldRetry: true,
        retryDelay: 5000,
        maxRetries: 2,
        fallback: 'notify',
        userMessage: 'API 请求过于频繁，正在等待...',
      };

    case ErrorCode.CONTEXT_LENGTH_EXCEEDED:
      return {
        shouldRetry: false,
        fallback: 'notify',
        userMessage: '对话内容过长，建议开始新会话或清理历史消息',
      };

    case ErrorCode.HOOK_BLOCKED:
      return {
        shouldRetry: false,
        fallback: 'abort',
      };

    case ErrorCode.TOOL_PERMISSION_DENIED:
    case ErrorCode.FILE_PERMISSION_DENIED:
    case ErrorCode.PATH_OUTSIDE_WORKSPACE:
      return {
        shouldRetry: false,
        fallback: 'notify',
      };

    case ErrorCode.API_KEY_INVALID:
      return {
        shouldRetry: false,
        fallback: 'abort',
        userMessage: '请检查 API 密钥配置',
      };

    default:
      return {
        shouldRetry: error.recoverable,
        retryDelay: 500,
        maxRetries: 1,
        fallback: 'notify',
      };
  }
}

// ----------------------------------------------------------------------------
// Error Logging
// ----------------------------------------------------------------------------

/**
 * Log error with appropriate level
 */
export function logError(error: CodeAgentError): void {
  const logData = {
    code: error.code,
    context: error.context,
    recoverable: error.recoverable,
  };

  switch (error.severity) {
    case ErrorSeverity.INFO:
      logger.info(error.message, logData);
      break;
    case ErrorSeverity.WARNING:
      logger.warn(error.message, logData);
      break;
    case ErrorSeverity.CRITICAL:
      logger.error(error.message, { ...logData, stack: error.stack });
      break;
    case ErrorSeverity.ERROR:
    default:
      logger.error(error.message, logData);
      break;
  }
}

// ----------------------------------------------------------------------------
// Error Wrapping
// ----------------------------------------------------------------------------

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: {
    context?: string;
    rethrow?: boolean;
    fallbackValue?: ReturnType<T> extends Promise<infer R> ? R : never;
  } = {}
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      const normalized = normalizeError(error);

      if (options.context) {
        normalized.context = {
          ...normalized.context,
          handlerContext: options.context,
        };
      }

      logError(normalized);

      if (options.rethrow !== false) {
        throw normalized;
      }

      return options.fallbackValue;
    }
  }) as T;
}

/**
 * Create a try-catch wrapper that returns result or error
 */
export async function tryCatch<T>(
  fn: () => Promise<T>
): Promise<{ success: true; data: T } | { success: false; error: CodeAgentError }> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: normalizeError(error) };
  }
}

// ----------------------------------------------------------------------------
// Error Formatting
// ----------------------------------------------------------------------------

/**
 * Format error for display to user
 */
export function formatErrorForUser(error: CodeAgentError): string {
  return error.userMessage;
}

/**
 * Format error for developer/logs
 */
export function formatErrorForDev(error: CodeAgentError): string {
  const parts = [
    `[${ErrorCode[error.code]}] ${error.message}`,
  ];

  if (error.context) {
    parts.push(`Context: ${JSON.stringify(error.context)}`);
  }

  if (error.stack) {
    parts.push(`Stack: ${error.stack}`);
  }

  return parts.join('\n');
}
