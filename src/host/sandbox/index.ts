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
// 只从桶里导出真有跨模块消费方的符号（bash.ts）；清单常量、sensitivePaths
// 等仅供后端内部/测试使用，测试直引模块路径——多余的桶级 re-export 会撞 knip 死出口棘轮。
export { resolveSandboxNetworkPolicy } from './networkPolicy';

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
