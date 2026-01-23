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
  SandboxManager,
  getSandboxManager,
  resetSandboxManager,
  executeInSandbox,
  type SandboxConfig,
  type SandboxResult,
  type SandboxManagerStatus,
  type SandboxPlatform,
  type SandboxPreset,
} from './manager';
