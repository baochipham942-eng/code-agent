// ============================================================================
// Error Types (Shared) - Types used by both main and renderer
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
