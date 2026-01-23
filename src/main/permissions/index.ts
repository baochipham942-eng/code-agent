// ============================================================================
// Permissions Module - Permission modes and policy engine
// ============================================================================

// Permission Modes
export {
  PermissionModeManager,
  getPermissionModeManager,
  resetPermissionModeManager,
  getCurrentMode,
  setPermissionMode,
  MODE_CONFIGS,
  type PermissionMode,
  type PermissionLevel,
  type PermissionAction,
  type PermissionRequest,
  type ModeConfig,
} from './modes';

// Policy Engine
export {
  PolicyEngine,
  getPolicyEngine,
  resetPolicyEngine,
  evaluatePermission,
  type PolicyMatcher,
  type PolicyRequest,
  type PolicyRule,
  type PolicyResult,
  type PolicyAuditEntry,
} from './policyEngine';
