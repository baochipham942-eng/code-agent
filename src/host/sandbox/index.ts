// ============================================================================
// Sandbox Module - Process isolation for command execution
// ============================================================================

// Bubblewrap (Linux)
export {
  Bubblewrap,
  getBubblewrap,
  resetBubblewrap,
  type BubblewrapConfig,
  type BubblewrapStatus,
} from './bubblewrap';

// Seatbelt (macOS)
export {
  Seatbelt,
  getSeatbelt,
  resetSeatbelt,
  type SeatbeltConfig,
  type SeatbeltStatus,
} from './seatbelt';

// Sandbox Manager (unified API)
export {
  NETWORK_COMMANDS,
  resolveSandboxNetworkPolicy,
  type SandboxNetworkPolicyInput,
} from './networkPolicy';

export {
  getSensitiveSandboxPaths,
  isPathDeniedBySensitiveSandboxPath,
  type SensitiveSandboxPath,
  type SensitiveSandboxPathKind,
  type SensitiveSandboxPathOptions,
} from './sensitivePaths';

export {
  SandboxManager,
  getSandboxManager,
  resetSandboxManager,
  executeInSandbox,
  wrapCommandForSandbox,
  type SandboxConfig,
  type SandboxResult,
  type SandboxManagerStatus,
  type SandboxPlatform,
  type SandboxPreset,
  type SandboxedCommand,
  type SandboxWrapOptions,
} from './manager';
