// ============================================================================
// Error Types - Unified error type hierarchy
// ============================================================================

/**
 * Error codes for categorization and handling
 */
export enum ErrorCode {
  // General errors (1xxx)
  UNKNOWN = 1000,
  INTERNAL = 1001,
  TIMEOUT = 1002,
  CANCELLED = 1003,

  // Configuration errors (2xxx)
  CONFIG_INVALID = 2000,
  CONFIG_MISSING = 2001,
  CONFIG_PARSE = 2002,

  // Tool errors (3xxx)
  TOOL_NOT_FOUND = 3000,
  TOOL_EXECUTION_FAILED = 3001,
  TOOL_PERMISSION_DENIED = 3002,
  TOOL_INVALID_PARAMS = 3003,
  TOOL_TIMEOUT = 3004,

  // File system errors (4xxx)
  FILE_NOT_FOUND = 4000,
  FILE_READ_ERROR = 4001,
  FILE_WRITE_ERROR = 4002,
  FILE_PERMISSION_DENIED = 4003,
  PATH_OUTSIDE_WORKSPACE = 4004,

  // Model/API errors (5xxx)
  MODEL_ERROR = 5000,
  CONTEXT_LENGTH_EXCEEDED = 5001,
  RATE_LIMIT_EXCEEDED = 5002,
  API_KEY_INVALID = 5003,
  API_CONNECTION_FAILED = 5004,
  MODEL_NOT_AVAILABLE = 5005,

  // Hook errors (6xxx)
  HOOK_EXECUTION_FAILED = 6000,
  HOOK_TIMEOUT = 6001,
  HOOK_BLOCKED = 6002,
  HOOK_CONFIG_INVALID = 6003,

  // Session errors (7xxx)
  SESSION_NOT_FOUND = 7000,
  SESSION_EXPIRED = 7001,
  SESSION_INVALID = 7002,

  // Agent errors (8xxx)
  AGENT_ERROR = 8000,
  AGENT_LOOP_LIMIT = 8001,
  AGENT_SUBAGENT_FAILED = 8002,
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  /** Informational - can be safely ignored */
  INFO = 'info',
  /** Warning - something unexpected but recoverable */
  WARNING = 'warning',
  /** Error - operation failed but system stable */
  ERROR = 'error',
  /** Critical - system may be unstable */
  CRITICAL = 'critical',
}

/**
 * Base error class for all Code Agent errors
 */
export class CodeAgentError extends Error {
  public readonly code: ErrorCode;
  public readonly severity: ErrorSeverity;
  public readonly timestamp: number;
  public context?: Record<string, unknown>; // Mutable to allow extending in error handlers
  public readonly recoverable: boolean;
  public readonly userMessage: string;

  constructor(
    message: string,
    options: {
      code?: ErrorCode;
      severity?: ErrorSeverity;
      context?: Record<string, unknown>;
      recoverable?: boolean;
      userMessage?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'CodeAgentError';
    this.code = options.code ?? ErrorCode.UNKNOWN;
    this.severity = options.severity ?? ErrorSeverity.ERROR;
    this.timestamp = Date.now();
    this.context = options.context;
    this.recoverable = options.recoverable ?? true;
    this.userMessage = options.userMessage ?? this.getDefaultUserMessage();
  }

  /**
   * Get a user-friendly message based on error code
   */
  private getDefaultUserMessage(): string {
    const messages: Partial<Record<ErrorCode, string>> = {
      [ErrorCode.TIMEOUT]: '操作超时，请稍后重试',
      [ErrorCode.TOOL_NOT_FOUND]: '找不到指定的工具',
      [ErrorCode.TOOL_PERMISSION_DENIED]: '没有执行此操作的权限',
      [ErrorCode.FILE_NOT_FOUND]: '找不到指定的文件',
      [ErrorCode.FILE_PERMISSION_DENIED]: '没有访问此文件的权限',
      [ErrorCode.PATH_OUTSIDE_WORKSPACE]: '不能访问工作目录外的文件',
      [ErrorCode.CONTEXT_LENGTH_EXCEEDED]: '对话内容过长，请开始新会话',
      [ErrorCode.RATE_LIMIT_EXCEEDED]: 'API 请求过于频繁，请稍后重试',
      [ErrorCode.API_KEY_INVALID]: 'API 密钥无效，请检查配置',
      [ErrorCode.API_CONNECTION_FAILED]: '无法连接到 API 服务',
      [ErrorCode.HOOK_BLOCKED]: '操作被 Hook 拦截',
    };

    return messages[this.code] ?? '发生了一个错误，请稍后重试';
  }

  /**
   * Serialize error for IPC transfer
   */
  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      recoverable: this.recoverable,
      userMessage: this.userMessage,
      stack: this.stack,
    };
  }

  /**
   * Create from serialized error
   */
  static fromJSON(data: SerializedError): CodeAgentError {
    const error = new CodeAgentError(data.message, {
      code: data.code,
      severity: data.severity,
      context: data.context,
      recoverable: data.recoverable,
      userMessage: data.userMessage,
    });
    error.stack = data.stack;
    return error;
  }
}

/**
 * Serialized error format for IPC
 */
export interface SerializedError {
  name: string;
  message: string;
  code: ErrorCode;
  severity: ErrorSeverity;
  timestamp: number;
  context?: Record<string, unknown>;
  recoverable: boolean;
  userMessage: string;
  stack?: string;
}

// ----------------------------------------------------------------------------
// Specific Error Classes
// ----------------------------------------------------------------------------

/**
 * Tool execution error
 */
export class ToolError extends CodeAgentError {
  constructor(
    toolName: string,
    message: string,
    options: {
      code?: ErrorCode;
      params?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: options.code ?? ErrorCode.TOOL_EXECUTION_FAILED,
      context: { toolName, params: options.params },
      cause: options.cause,
    });
    this.name = 'ToolError';
  }
}

/**
 * File system error
 */
export class FileSystemError extends CodeAgentError {
  constructor(
    filePath: string,
    operation: 'read' | 'write' | 'delete' | 'access',
    options: {
      code?: ErrorCode;
      cause?: Error;
    } = {}
  ) {
    const codeMap: Record<string, ErrorCode> = {
      read: ErrorCode.FILE_READ_ERROR,
      write: ErrorCode.FILE_WRITE_ERROR,
      delete: ErrorCode.FILE_WRITE_ERROR,
      access: ErrorCode.FILE_PERMISSION_DENIED,
    };

    super(`File ${operation} failed: ${filePath}`, {
      code: options.code ?? codeMap[operation],
      context: { filePath, operation },
      cause: options.cause,
    });
    this.name = 'FileSystemError';
  }
}

/**
 * Model/API error
 */
export class ModelError extends CodeAgentError {
  constructor(
    provider: string,
    message: string,
    options: {
      code?: ErrorCode;
      model?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: options.code ?? ErrorCode.MODEL_ERROR,
      context: { provider, model: options.model },
      cause: options.cause,
    });
    this.name = 'ModelError';
  }
}

/**
 * Hook error
 */
export class HookError extends CodeAgentError {
  constructor(
    event: string,
    message: string,
    options: {
      code?: ErrorCode;
      hookType?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: options.code ?? ErrorCode.HOOK_EXECUTION_FAILED,
      context: { event, hookType: options.hookType },
      cause: options.cause,
    });
    this.name = 'HookError';
  }
}

/**
 * Configuration error
 */
export class ConfigError extends CodeAgentError {
  constructor(
    configPath: string,
    message: string,
    options: {
      code?: ErrorCode;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: options.code ?? ErrorCode.CONFIG_INVALID,
      context: { configPath },
      cause: options.cause,
    });
    this.name = 'ConfigError';
  }
}
