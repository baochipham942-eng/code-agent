// ============================================================================
// Error Classifier - 细化的错误分类系统
// ============================================================================
// 将错误分类为更细粒度的类型，便于针对性恢复
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { ErrorCode } from './types';

const logger = createLogger('ErrorClassifier');

/**
 * 详细错误类型枚举
 */
export enum DetailedErrorType {
  // 网络相关
  NETWORK_TIMEOUT = 'network_timeout',
  NETWORK_CONNECTION = 'network_connection',
  NETWORK_DNS = 'network_dns',
  NETWORK_SSL = 'network_ssl',

  // 限流相关
  RATE_LIMIT_API = 'rate_limit_api',
  RATE_LIMIT_RESOURCE = 'rate_limit_resource',
  RATE_LIMIT_TOKEN = 'rate_limit_token',

  // 权限相关
  PERMISSION_FILE = 'permission_file',
  PERMISSION_API = 'permission_api',
  PERMISSION_HOOK = 'permission_hook',

  // 逻辑相关
  LOGIC_VALIDATION = 'logic_validation',
  LOGIC_STATE = 'logic_state',
  LOGIC_DEPENDENCY = 'logic_dependency',

  // 资源相关
  RESOURCE_NOT_FOUND = 'resource_not_found',
  RESOURCE_CONFLICT = 'resource_conflict',
  RESOURCE_EXHAUSTED = 'resource_exhausted',

  // 模型相关
  MODEL_CONTEXT_LENGTH = 'model_context_length',
  MODEL_RESPONSE_INVALID = 'model_response_invalid',
  MODEL_NOT_AVAILABLE = 'model_not_available',

  // 工具相关
  TOOL_NOT_FOUND = 'tool_not_found',
  TOOL_PARAM_INVALID = 'tool_param_invalid',
  TOOL_EXECUTION_FAILED = 'tool_execution_failed',

  // 未知
  UNKNOWN = 'unknown',
}

/**
 * 错误分类结果
 */
export interface ErrorClassification {
  type: DetailedErrorType;
  category: 'network' | 'rate_limit' | 'permission' | 'logic' | 'resource' | 'model' | 'tool' | 'unknown';
  isTransient: boolean;  // 是否是暂时性错误（可重试）
  retryable: boolean;    // 是否建议重试
  retryDelay?: number;   // 建议重试延迟（毫秒）
  maxRetries?: number;   // 建议最大重试次数
  confidence: number;    // 分类置信度 (0-1)
  context?: Record<string, unknown>;
}

/**
 * 错误模式匹配规则
 */
interface ErrorPattern {
  type: DetailedErrorType;
  patterns: (string | RegExp)[];
  category: ErrorClassification['category'];
  isTransient: boolean;
  retryable: boolean;
  retryDelay?: number;
  maxRetries?: number;
}

/**
 * 错误分类器
 */
export class ErrorClassifier {
  private patterns: ErrorPattern[] = [
    // 网络相关
    {
      type: DetailedErrorType.NETWORK_TIMEOUT,
      patterns: [
        'timeout', 'timed out', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
        'read ECONNRESET', 'socket hang up',
      ],
      category: 'network',
      isTransient: true,
      retryable: true,
      retryDelay: 1000,
      maxRetries: 3,
    },
    {
      type: DetailedErrorType.NETWORK_CONNECTION,
      patterns: [
        'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
        'connection refused', 'network error', 'fetch failed',
      ],
      category: 'network',
      isTransient: true,
      retryable: true,
      retryDelay: 2000,
      maxRetries: 3,
    },
    {
      type: DetailedErrorType.NETWORK_DNS,
      patterns: ['ENOTFOUND', 'getaddrinfo', 'DNS'],
      category: 'network',
      isTransient: true,
      retryable: true,
      retryDelay: 5000,
      maxRetries: 2,
    },
    {
      type: DetailedErrorType.NETWORK_SSL,
      patterns: [
        'SSL', 'certificate', 'CERT_', 'TLS',
        'unable to verify', 'self signed',
      ],
      category: 'network',
      isTransient: false,
      retryable: false,
    },

    // 限流相关
    {
      type: DetailedErrorType.RATE_LIMIT_API,
      patterns: [
        /rate.?limit/i, '429', 'too many requests',
        'quota exceeded', 'requests per minute',
      ],
      category: 'rate_limit',
      isTransient: true,
      retryable: true,
      retryDelay: 60000, // 1 分钟
      maxRetries: 2,
    },
    {
      type: DetailedErrorType.RATE_LIMIT_TOKEN,
      patterns: [
        'tokens per minute', 'TPM', 'token limit',
        'context length', 'max tokens',
      ],
      category: 'rate_limit',
      isTransient: true,
      retryable: false, // 需要减少输入
    },
    {
      type: DetailedErrorType.RATE_LIMIT_RESOURCE,
      patterns: [
        'resource exhausted', 'capacity', 'overloaded',
        'server busy', 'try again later',
      ],
      category: 'rate_limit',
      isTransient: true,
      retryable: true,
      retryDelay: 30000,
      maxRetries: 3,
    },

    // 权限相关
    {
      type: DetailedErrorType.PERMISSION_FILE,
      patterns: [
        'EACCES', 'EPERM', 'permission denied',
        'not permitted', 'access denied',
        'outside workspace', 'not allowed',
      ],
      category: 'permission',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.PERMISSION_API,
      patterns: [
        '401', '403', 'unauthorized', 'forbidden',
        'invalid api key', 'authentication failed',
        'invalid credentials',
      ],
      category: 'permission',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.PERMISSION_HOOK,
      patterns: ['blocked by hook', 'hook rejected', 'hook denied'],
      category: 'permission',
      isTransient: false,
      retryable: false,
    },

    // 逻辑相关
    {
      type: DetailedErrorType.LOGIC_VALIDATION,
      patterns: [
        'validation', 'invalid', 'malformed',
        'parse error', 'syntax error', 'type error',
      ],
      category: 'logic',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.LOGIC_STATE,
      patterns: [
        'state', 'conflict', 'already exists',
        'not found', 'does not exist', 'missing',
      ],
      category: 'logic',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.LOGIC_DEPENDENCY,
      patterns: [
        'dependency', 'requires', 'depends on',
        'prerequisite', 'blocked by',
      ],
      category: 'logic',
      isTransient: false,
      retryable: false,
    },

    // 资源相关
    {
      type: DetailedErrorType.RESOURCE_NOT_FOUND,
      patterns: [
        '404', 'not found', 'no such file',
        'ENOENT', 'does not exist',
      ],
      category: 'resource',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.RESOURCE_CONFLICT,
      patterns: [
        '409', 'conflict', 'already exists',
        'duplicate', 'collision',
      ],
      category: 'resource',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.RESOURCE_EXHAUSTED,
      patterns: [
        'out of memory', 'disk full', 'no space',
        'ENOSPC', 'quota',
      ],
      category: 'resource',
      isTransient: false,
      retryable: false,
    },

    // 模型相关
    {
      type: DetailedErrorType.MODEL_CONTEXT_LENGTH,
      patterns: [
        'context length', 'maximum context',
        'token limit exceeded', 'too long',
      ],
      category: 'model',
      isTransient: false,
      retryable: false, // 需要减少上下文
    },
    {
      type: DetailedErrorType.MODEL_RESPONSE_INVALID,
      patterns: [
        'invalid response', 'malformed response',
        'unexpected format', 'parse model response',
      ],
      category: 'model',
      isTransient: true,
      retryable: true,
      retryDelay: 1000,
      maxRetries: 2,
    },
    {
      type: DetailedErrorType.MODEL_NOT_AVAILABLE,
      patterns: [
        'model not found', 'model unavailable',
        'model not supported', 'no model',
      ],
      category: 'model',
      isTransient: false,
      retryable: false,
    },

    // 工具相关
    {
      type: DetailedErrorType.TOOL_NOT_FOUND,
      patterns: ['tool not found', 'unknown tool', 'no such tool'],
      category: 'tool',
      isTransient: false,
      retryable: false,
    },
    {
      type: DetailedErrorType.TOOL_PARAM_INVALID,
      patterns: [
        'invalid parameter', 'missing parameter',
        'invalid argument', 'bad argument',
      ],
      category: 'tool',
      isTransient: false,
      retryable: false, // 需要修正参数
    },
    {
      type: DetailedErrorType.TOOL_EXECUTION_FAILED,
      patterns: [
        'tool execution failed', 'tool error',
        'command failed', 'exit code',
      ],
      category: 'tool',
      isTransient: false,
      retryable: false, // 需要分析原因
    },
  ];

  /**
   * 分类错误
   */
  classify(error: Error | string, context?: Record<string, unknown>): ErrorClassification {
    const message = error instanceof Error ? error.message : error;
    const normalizedMessage = message.toLowerCase();

    let bestMatch: { pattern: ErrorPattern; confidence: number } | null = null;

    for (const pattern of this.patterns) {
      for (const p of pattern.patterns) {
        let matched = false;
        let confidence = 0;

        if (typeof p === 'string') {
          matched = normalizedMessage.includes(p.toLowerCase());
          confidence = matched ? 0.8 : 0;
        } else {
          matched = p.test(message);
          confidence = matched ? 0.9 : 0;
        }

        if (matched && (!bestMatch || confidence > bestMatch.confidence)) {
          bestMatch = { pattern, confidence };
        }
      }
    }

    if (bestMatch) {
      return {
        type: bestMatch.pattern.type,
        category: bestMatch.pattern.category,
        isTransient: bestMatch.pattern.isTransient,
        retryable: bestMatch.pattern.retryable,
        retryDelay: bestMatch.pattern.retryDelay,
        maxRetries: bestMatch.pattern.maxRetries,
        confidence: bestMatch.confidence,
        context,
      };
    }

    // 未知错误
    return {
      type: DetailedErrorType.UNKNOWN,
      category: 'unknown',
      isTransient: false,
      retryable: false,
      confidence: 0.5,
      context,
    };
  }

  /**
   * 从 ErrorCode 映射到 DetailedErrorType
   */
  fromErrorCode(code: ErrorCode): DetailedErrorType {
    const mapping: Partial<Record<ErrorCode, DetailedErrorType>> = {
      [ErrorCode.TIMEOUT]: DetailedErrorType.NETWORK_TIMEOUT,
      [ErrorCode.TOOL_NOT_FOUND]: DetailedErrorType.TOOL_NOT_FOUND,
      [ErrorCode.TOOL_PERMISSION_DENIED]: DetailedErrorType.PERMISSION_FILE,
      [ErrorCode.TOOL_INVALID_PARAMS]: DetailedErrorType.TOOL_PARAM_INVALID,
      [ErrorCode.TOOL_TIMEOUT]: DetailedErrorType.NETWORK_TIMEOUT,
      [ErrorCode.FILE_NOT_FOUND]: DetailedErrorType.RESOURCE_NOT_FOUND,
      [ErrorCode.FILE_PERMISSION_DENIED]: DetailedErrorType.PERMISSION_FILE,
      [ErrorCode.PATH_OUTSIDE_WORKSPACE]: DetailedErrorType.PERMISSION_FILE,
      [ErrorCode.CONTEXT_LENGTH_EXCEEDED]: DetailedErrorType.MODEL_CONTEXT_LENGTH,
      [ErrorCode.RATE_LIMIT_EXCEEDED]: DetailedErrorType.RATE_LIMIT_API,
      [ErrorCode.API_KEY_INVALID]: DetailedErrorType.PERMISSION_API,
      [ErrorCode.API_CONNECTION_FAILED]: DetailedErrorType.NETWORK_CONNECTION,
      [ErrorCode.MODEL_NOT_AVAILABLE]: DetailedErrorType.MODEL_NOT_AVAILABLE,
      [ErrorCode.HOOK_BLOCKED]: DetailedErrorType.PERMISSION_HOOK,
    };

    return mapping[code] || DetailedErrorType.UNKNOWN;
  }

  /**
   * 检查错误是否应该重试
   */
  shouldRetry(classification: ErrorClassification, attemptCount: number): boolean {
    if (!classification.retryable) {
      return false;
    }

    const maxRetries = classification.maxRetries || 3;
    return attemptCount < maxRetries;
  }

  /**
   * 获取重试延迟
   */
  getRetryDelay(classification: ErrorClassification, attemptCount: number): number {
    const baseDelay = classification.retryDelay || 1000;
    // 指数退避
    return baseDelay * Math.pow(2, attemptCount);
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let classifierInstance: ErrorClassifier | null = null;

export function getErrorClassifier(): ErrorClassifier {
  if (!classifierInstance) {
    classifierInstance = new ErrorClassifier();
  }
  return classifierInstance;
}
