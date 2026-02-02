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
      // General errors
      [ErrorCode.UNKNOWN]: '发生了未知错误',
      [ErrorCode.INTERNAL]: '内部错误',
      [ErrorCode.TIMEOUT]: '操作超时',
      [ErrorCode.CANCELLED]: '操作已取消',

      // Configuration errors
      [ErrorCode.CONFIG_INVALID]: '配置无效',
      [ErrorCode.CONFIG_MISSING]: '配置缺失',
      [ErrorCode.CONFIG_PARSE]: '配置解析失败',

      // Tool errors
      [ErrorCode.TOOL_NOT_FOUND]: '找不到指定的工具',
      [ErrorCode.TOOL_EXECUTION_FAILED]: '工具执行失败',
      [ErrorCode.TOOL_PERMISSION_DENIED]: '没有执行此操作的权限',
      [ErrorCode.TOOL_INVALID_PARAMS]: '工具参数无效',
      [ErrorCode.TOOL_TIMEOUT]: '工具执行超时',

      // File system errors
      [ErrorCode.FILE_NOT_FOUND]: '找不到指定的文件',
      [ErrorCode.FILE_READ_ERROR]: '文件读取失败',
      [ErrorCode.FILE_WRITE_ERROR]: '文件写入失败',
      [ErrorCode.FILE_PERMISSION_DENIED]: '没有访问此文件的权限',
      [ErrorCode.PATH_OUTSIDE_WORKSPACE]: '不能访问工作目录外的文件',

      // Model/API errors
      [ErrorCode.MODEL_ERROR]: '模型调用失败',
      [ErrorCode.CONTEXT_LENGTH_EXCEEDED]: '对话内容过长',
      [ErrorCode.RATE_LIMIT_EXCEEDED]: 'API 请求过于频繁',
      [ErrorCode.API_KEY_INVALID]: 'API 密钥无效',
      [ErrorCode.API_CONNECTION_FAILED]: '无法连接到 API 服务',
      [ErrorCode.MODEL_NOT_AVAILABLE]: '模型不可用',

      // Hook errors
      [ErrorCode.HOOK_EXECUTION_FAILED]: 'Hook 执行失败',
      [ErrorCode.HOOK_TIMEOUT]: 'Hook 执行超时',
      [ErrorCode.HOOK_BLOCKED]: '操作被 Hook 拦截',
      [ErrorCode.HOOK_CONFIG_INVALID]: 'Hook 配置无效',

      // Session errors
      [ErrorCode.SESSION_NOT_FOUND]: '会话不存在',
      [ErrorCode.SESSION_EXPIRED]: '会话已过期',
      [ErrorCode.SESSION_INVALID]: '会话无效',

      // Agent errors
      [ErrorCode.AGENT_ERROR]: 'Agent 执行错误',
      [ErrorCode.AGENT_LOOP_LIMIT]: 'Agent 循环次数超限',
      [ErrorCode.AGENT_SUBAGENT_FAILED]: '子 Agent 执行失败',
    };

    return messages[this.code] ?? '发生了一个错误';
  }

  /**
   * Get recovery suggestion based on error code
   */
  getRecoverySuggestion(): string {
    const suggestions: Partial<Record<ErrorCode, string>> = {
      // General errors
      [ErrorCode.TIMEOUT]: '请检查网络连接，或稍后重试',
      [ErrorCode.CANCELLED]: '操作已取消，可以重新开始',

      // Configuration errors
      [ErrorCode.CONFIG_INVALID]: '请检查配置文件格式是否正确',
      [ErrorCode.CONFIG_MISSING]: '请在设置中完成必要的配置',
      [ErrorCode.CONFIG_PARSE]: '请检查配置文件的 JSON 格式',

      // Tool errors
      [ErrorCode.TOOL_NOT_FOUND]: '请确认工具名称是否正确，或检查 MCP 服务器状态',
      [ErrorCode.TOOL_EXECUTION_FAILED]: '请检查命令参数或目标文件状态',
      [ErrorCode.TOOL_PERMISSION_DENIED]: '请检查文件权限或安全模式设置',
      [ErrorCode.TOOL_INVALID_PARAMS]: '请检查工具参数格式',
      [ErrorCode.TOOL_TIMEOUT]: '命令执行时间过长，考虑拆分任务或增加超时时间',

      // File system errors
      [ErrorCode.FILE_NOT_FOUND]: '请确认文件路径是否正确',
      [ErrorCode.FILE_READ_ERROR]: '请检查文件是否被占用或损坏',
      [ErrorCode.FILE_WRITE_ERROR]: '请检查磁盘空间和写入权限',
      [ErrorCode.FILE_PERMISSION_DENIED]: '请检查文件权限，或使用管理员权限运行',
      [ErrorCode.PATH_OUTSIDE_WORKSPACE]: '请将文件移至工作目录内，或更改工作目录',

      // Model/API errors
      [ErrorCode.MODEL_ERROR]: '请稍后重试，或尝试切换模型',
      [ErrorCode.CONTEXT_LENGTH_EXCEEDED]: '请开始新会话，或删除部分历史消息',
      [ErrorCode.RATE_LIMIT_EXCEEDED]: '请等待 1 分钟后重试',
      [ErrorCode.API_KEY_INVALID]: '请在设置中检查并更新 API 密钥',
      [ErrorCode.API_CONNECTION_FAILED]: '请检查网络连接和 API 地址配置',
      [ErrorCode.MODEL_NOT_AVAILABLE]: '请切换到其他可用模型',

      // Hook errors
      [ErrorCode.HOOK_EXECUTION_FAILED]: '请检查 Hook 脚本是否有语法错误',
      [ErrorCode.HOOK_TIMEOUT]: '请优化 Hook 脚本执行效率',
      [ErrorCode.HOOK_BLOCKED]: '此操作被安全策略阻止，请调整 Hook 配置',
      [ErrorCode.HOOK_CONFIG_INVALID]: '请检查 .claude/settings.json 中的 Hook 配置',

      // Session errors
      [ErrorCode.SESSION_NOT_FOUND]: '请刷新会话列表或创建新会话',
      [ErrorCode.SESSION_EXPIRED]: '请重新开始一个新会话',
      [ErrorCode.SESSION_INVALID]: '请刷新页面或重启应用',

      // Agent errors
      [ErrorCode.AGENT_ERROR]: '请简化任务描述后重试',
      [ErrorCode.AGENT_LOOP_LIMIT]: '任务过于复杂，请拆分为多个小任务',
      [ErrorCode.AGENT_SUBAGENT_FAILED]: '子任务执行失败，请检查具体错误信息',
    };

    return suggestions[this.code] ?? '请稍后重试，如果问题持续，请联系支持';
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
      recoverySuggestion: this.getRecoverySuggestion(),
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
  recoverySuggestion?: string;
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

// Re-export detailed error types for convenience
export { DetailedErrorType, type ErrorClassification } from './errorClassifier';
