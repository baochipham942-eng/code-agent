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

// ── 可渲染快照（view-model）─────────────────────────────────────────────────
// 「事件流 → 可渲染快照」中间层契约（照搬 pi-dynamic-workflows 的 WorkflowSnapshot/
// WorkflowAgentSnapshot + 5 态状态机 + snapshot/recompute 模式）。渲染走 Neo 独立 GUI
// 面板（pi 是 TUI 抄不了），数据契约照搬。reducer 是纯函数，main/renderer 两端共用。

/** 子 agent 5 态状态机。Neo 当前事件只驱动 running/done/error；queued/skipped 为契约预留。 */
export type ScriptRunAgentStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped';

export interface ScriptRunAgentSnapshot {
  /** 子 agent 唯一 id（`${runId}-a${n}`）。 */
  id: string;
  /** 进度显示标签。 */
  label: string;
  /** 归属 phase（用于进度树分组）。 */
  phase?: string;
  /** 任务 prompt 预览（截断）。 */
  promptPreview?: string;
  provider?: string;
  model?: string;
  /** 是否走 forced structured（单轮判官）。 */
  hasSchema?: boolean;
  status: ScriptRunAgentStatus;
  /** 完成结果预览（截断）。 */
  resultPreview?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 一次 run 的可渲染快照。由事件流经 applyScriptRunEvent 折叠得到。 */
export interface ScriptRunSnapshot {
  runId: string;
  status: RunStatus;
  goal?: string;
  scriptHash?: string;
  /** 去重累积的 phase 标题（进度树分组头）。 */
  phases: string[];
  /** 最新 phase。 */
  currentPhase?: string;
  logs: string[];
  agents: ScriptRunAgentSnapshot[];
  runningCount: number;
  doneCount: number;
  errorCount: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
}

/** 空快照（run 尚未收到任何事件时的初态）。 */
export function emptyScriptRunSnapshot(runId: string): ScriptRunSnapshot {
  return {
    runId,
    status: 'pending',
    phases: [],
    logs: [],
    agents: [],
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 从 agents 数组重算三个计数。 */
function recountAgents(
  agents: ScriptRunAgentSnapshot[],
): Pick<ScriptRunSnapshot, 'runningCount' | 'doneCount' | 'errorCount'> {
  let runningCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  for (const a of agents) {
    if (a.status === 'running' || a.status === 'queued') runningCount++;
    else if (a.status === 'done') doneCount++;
    else if (a.status === 'error') errorCount++;
  }
  return { runningCount, doneCount, errorCount };
}

/**
 * 纯函数 reducer：把单个 ScriptRunEvent 折叠进快照，返回新快照（不就地改入参）。
 * 多 run 隔离由调用方按 runId 分桶（每个 run 一个快照），本函数只管单 run。
 */
export function applyScriptRunEvent(prev: ScriptRunSnapshot, event: ScriptRunEvent): ScriptRunSnapshot {
  const data = event.data ?? {};
  switch (event.type) {
    case 'run:start':
      return {
        ...prev,
        status: 'running',
        goal: str(data.goal) ?? prev.goal,
        scriptHash: str(data.scriptHash) ?? prev.scriptHash,
        startedAt: prev.startedAt ?? event.ts,
      };

    case 'run:phase': {
      const title = str(data.title);
      if (!title) return prev;
      const phases = prev.phases.includes(title) ? prev.phases : [...prev.phases, title];
      return { ...prev, phases, currentPhase: title };
    }

    case 'run:log': {
      const message = str(data.message);
      if (message === undefined) return prev;
      return { ...prev, logs: [...prev.logs, message] };
    }

    case 'agent:start': {
      const id = str(data.agentId);
      if (!id) return prev;
      const agent: ScriptRunAgentSnapshot = {
        id,
        label: str(data.label) ?? 'agent',
        phase: str(data.phase) ?? prev.currentPhase,
        promptPreview: str(data.promptPreview),
        provider: str(data.provider),
        model: str(data.model),
        hasSchema: typeof data.hasSchema === 'boolean' ? data.hasSchema : undefined,
        status: 'running',
        startedAt: event.ts,
      };
      const agents = upsertAgent(prev.agents, agent);
      return { ...prev, agents, ...recountAgents(agents) };
    }

    case 'agent:done': {
      const id = str(data.agentId);
      if (!id) return prev;
      const agents = patchAgent(prev.agents, id, {
        status: 'done',
        resultPreview: str(data.resultPreview),
        finishedAt: event.ts,
      });
      return { ...prev, agents, ...recountAgents(agents) };
    }

    case 'agent:error': {
      const id = str(data.agentId);
      if (!id) return prev;
      const agents = patchAgent(prev.agents, id, {
        status: 'error',
        error: str(data.error),
        finishedAt: event.ts,
      });
      return { ...prev, agents, ...recountAgents(agents) };
    }

    case 'run:done':
      return {
        ...prev,
        status: 'completed',
        result: data.result,
        finishedAt: event.ts,
        durationMs: prev.startedAt !== undefined ? event.ts - prev.startedAt : prev.durationMs,
      };

    case 'run:error':
      return {
        ...prev,
        status: 'failed',
        error: str(data.error),
        finishedAt: event.ts,
        durationMs: prev.startedAt !== undefined ? event.ts - prev.startedAt : prev.durationMs,
      };

    default:
      return prev;
  }
}

/** 按 id upsert（已存在则合并补字段，不存在则追加）。 */
function upsertAgent(
  agents: ScriptRunAgentSnapshot[],
  next: ScriptRunAgentSnapshot,
): ScriptRunAgentSnapshot[] {
  const idx = agents.findIndex((a) => a.id === next.id);
  if (idx < 0) return [...agents, next];
  const merged = { ...agents[idx], ...next };
  return agents.map((a, i) => (i === idx ? merged : a));
}

/** 按 id 局部更新（只覆盖给定字段，undefined 不覆盖既有值）。 */
function patchAgent(
  agents: ScriptRunAgentSnapshot[],
  id: string,
  patch: Partial<ScriptRunAgentSnapshot>,
): ScriptRunAgentSnapshot[] {
  return agents.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    return next;
  });
}
