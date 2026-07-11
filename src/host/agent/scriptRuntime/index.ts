// ============================================================================
// scriptRuntime —— dynamic-workflow 命令式脚本运行时（对外 facade）
//
// /workflow 命令层（P3）调 startRun(spec, deps) 触发；deps 提供与宿主 toolContext/
// configService/toolResolver 的接驳。运行时把模型写的 JS 编排脚本跑在独立进程沙箱，
// agent()/parallel()/pipeline()/phase()/log() 落到主线程受控执行。
// ============================================================================

export {
  startRun,
  cancelRun,
  getRunState,
  type ScriptRunHostDeps,
  type ScriptRunJournal,
  type ScriptRunPriorJournal,
} from './runService';
export type { ScriptRunContext } from './agentBridge';
export { ConcurrencyGate } from './concurrencyGate';
export {
  ORCHESTRATION_CAPABILITIES,
  capabilityManifestForToolProfile,
  capabilityManifestForTools,
} from './capabilityManifest';
export type { CapabilityManifest } from './capabilityManifest';
export type {
  ScriptRunSpec,
  ScriptRunState,
  ScriptRunEvent,
  ScriptRunEventType,
  ScriptMeta,
  RunStatus,
  AgentCallOptions,
  AgentCallPayload,
  PrimitiveResult,
  JsonSchema,
  AgentWorkspaceLease,
  AgentWorkspaceHandoff,
} from './types';
