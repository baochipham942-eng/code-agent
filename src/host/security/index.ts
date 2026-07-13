// ============================================================================
// Security Module - Runtime security monitoring and audit logging
// ============================================================================

// Command Safety (safe whitelist + dangerous pattern detection)
export {
  isKnownSafeCommand,
  validateCommand,
  getShellSafetyMode,
  type ValidationResult,
} from './commandSafety';

// Sensitive Detector
export {
  maskSensitiveData,
} from './sensitiveDetector';

// Audit Logger
export {
  getAuditLogger,
} from './auditLogger';

// Log Masker
export {
  getLogMasker,
} from './logMasker';

// (commandSafety exports are at the top of this file)

// Exec Policy (persistent approval rules)
export {
  getExecPolicyStore,
} from './execPolicy';

// Policy Enforcer (code-agent-policy.toml hard rules — deny cannot be overridden)
export {
  PolicyEnforcer,
  getPolicyEnforcer,
  type PolicyCheckResult,
} from './policyEnforcer';
