// ============================================================================
// scriptRun —— dynamic-workflow 运行时的【跨层可序列化契约】
//
// 这里只放 main 运行时与 renderer 视图层【都要消费】的纯数据类型：run 生命周期事件
// （ScriptRunEvent）+ 状态枚举（RunStatus）。运行时内部类型（RPC/WorkerInit/
// ScriptRunSpec 等）仍留在 src/main/agent/scriptRuntime/types.ts。
//
// 分层约束：renderer 从不 import @main（见 swarmStore 范式），故所有「事件流 → 可渲染
// 快照」的契约必须落在 @shared。main 侧的 scriptRuntime/types.ts re-export 本文件，
// 既有 importer 零改动。
// ============================================================================

// ── run 生命周期状态 ─────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ── run 事件（scriptRuntime 自有事件流，不复用 swarm 单-active-run 的 SwarmEventEmitter）──

export type ScriptRunEventType =
  | 'run:start'
  | 'run:phase'
  | 'run:log'
  | 'agent:start'
  | 'agent:done'
  | 'agent:error'
  | 'run:done'
  | 'run:error';

export interface ScriptRunEvent {
  runId: string;
  type: ScriptRunEventType;
  ts: number;
  data?: Record<string, unknown>;
}
