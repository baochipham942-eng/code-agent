// ============================================================================
// Security Module - Runtime security monitoring and audit logging
// ============================================================================

// Command Monitor
export {
  CommandMonitor,
  getCommandMonitor,
  resetCommandMonitor,
  type ValidationResult,
  type ExecutionResult,
  type CommandAuditEntry,
} from './commandMonitor';

// Sensitive Detector
export {
  SensitiveDetector,
  getSensitiveDetector,
  resetSensitiveDetector,
  maskSensitiveData,
  type SensitiveType,
  type SensitiveMatch,
  type DetectionResult,
} from './sensitiveDetector';

// Audit Logger
export {
  AuditLogger,
  getAuditLogger,
  resetAuditLogger,
  type AuditEventType,
  type AuditEntry,
  type AuditQueryOptions,
  type AuditQueryResult,
} from './auditLogger';

// Log Masker
export {
  LogMasker,
  getLogMasker,
  resetLogMasker,
  maskText,
  maskCommand,
  type MaskingOptions,
  type MaskingResult,
} from './logMasker';

// Input Sanitizer
export {
  InputSanitizer,
  getInputSanitizer,
  resetInputSanitizer,
  type SanitizationResult,
  type SanitizationWarning,
  type SanitizationConfig,
  type SanitizationMode,
} from './inputSanitizer';
