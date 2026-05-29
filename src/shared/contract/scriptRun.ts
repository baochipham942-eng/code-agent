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
  /** 归属会话（命令层 stamp，用于 renderer 会话隔离过滤；headless/dev 注入可缺省）。 */
  sessionId?: string;
}

// ── 跑前审批（P3b）──────────────────────────────────────────────────────────
// dynamic-workflow 启动前的确认闸：展示静态预览（phases/扇出量/动写）+ 4 维度成本提示，
// 复用 swarmLaunchApproval 的 Promise+EventBus+pendingResolvers 机制但用独立契约（workflow
// 跑前没有 tasks[]，只有脚本静态预览 + token 预算）。

/** 审批卡展示的 4 个成本/风险维度（advisory 文案）。 */
export interface WorkflowLaunchDimensions {
  /** 费用：扇出量 + token 预算上限。 */
  cost: string;
  /** 网络：子 agent 联网能力。 */
  network: string;
  /** 上下文泄露：中间结果是否进主对话。 */
  contextLeak: string;
  /** 后台占用：执行位置 + 时长上限。 */
  background: string;
}

/** 一次 workflow 启动审批请求。 */
export interface WorkflowLaunchRequest {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  resolvedAt?: number;
  sessionId?: string;
  /** /workflow <goal> 的目标。 */
  goal?: string;
  /** 脚本静态预览抽出的 phase 标题（声明顺序）。 */
  phases: string[];
  /** agent() 调用点估计（扇出量）。 */
  estimatedAgentCalls: number;
  /** parallel()+pipeline() 调用点数（并行度提示）。 */
  fanoutSites: number;
  /** 脚本是否含写能力 agent（tools:edit|full）。 */
  writeHint: boolean;
  /** token 预算上限（outputTokens），未设为 undefined（= 不限）。 */
  budgetTokens?: number;
  dimensions: WorkflowLaunchDimensions;
  /** 用户审批时的可选说明 / 拒绝原因。 */
  feedback?: string;
}

/** 审批卡推送事件（workflow:launch:event 通道）。 */
export interface WorkflowLaunchEvent {
  type: 'requested' | 'approved' | 'rejected';
  request: WorkflowLaunchRequest;
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
  /** 归属会话（用于 renderer 会话隔离过滤）。 */
  sessionId?: string;
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
        sessionId: event.sessionId ?? prev.sessionId, // 会话隔离用（HIGH#1）
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
      // upsert 而非 patch（Codex R1 MED#2）：emit best-effort 可能丢 agent:start，
      // 终态遇未知 id 必须补一条，否则计数/结果被静默吃掉。
      const agents = upsertTerminalAgent(prev.agents, id, {
        label: str(data.label) ?? 'agent',
        status: 'done',
        resultPreview: str(data.resultPreview),
        finishedAt: event.ts,
      });
      return { ...prev, agents, ...recountAgents(agents) };
    }

    case 'agent:error': {
      const id = str(data.agentId);
      if (!id) return prev;
      const agents = upsertTerminalAgent(prev.agents, id, {
        label: str(data.label) ?? 'agent',
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

/**
 * 终态事件（agent:done/error）的 upsert：已存在则局部覆盖（undefined 不覆盖既有值），
 * 不存在则补一条新 agent（emit best-effort 丢了 agent:start 的兜底，Codex R1 MED#2）。
 * patch 必须带 status；新建时 status 取自 patch。
 */
function upsertTerminalAgent(
  agents: ScriptRunAgentSnapshot[],
  id: string,
  patch: Partial<ScriptRunAgentSnapshot> & { status: ScriptRunAgentStatus },
): ScriptRunAgentSnapshot[] {
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) {
    const created: ScriptRunAgentSnapshot = { id, label: patch.label ?? 'agent', status: patch.status };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (created as unknown as Record<string, unknown>)[k] = v;
    }
    return [...agents, created];
  }
  return agents.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    return next;
  });
}
