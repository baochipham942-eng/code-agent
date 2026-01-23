// ============================================================================
// Errors Module - Unified error handling
// ============================================================================

// Error types
export {
  ErrorCode,
  ErrorSeverity,
  CodeAgentError,
  ToolError,
  FileSystemError,
  ModelError,
  HookError,
  ConfigError,
  type SerializedError,
} from './types';

// Error handling utilities
export {
  normalizeError,
  getRecoveryStrategy,
  logError,
  withErrorHandling,
  tryCatch,
  formatErrorForUser,
  formatErrorForDev,
  type RecoveryStrategy,
} from './handler';
