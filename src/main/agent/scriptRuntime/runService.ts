// ============================================================================
// runService —— dynamic-workflow run 编排（主线程）
//
// 串起：宿主依赖 → ScriptRunContext → worker 沙箱 → RPC 泵送 → 事件/状态累积。
// 多 run 隔离：每个 run 独立 AbortController + ConcurrencyGate + state，存于 activeRuns；
// 不复用 swarm 的 SwarmEventEmitter（其单-active-run 假设会串 run，艾克斯审计）。
// ============================================================================

import { createHash } from 'node:crypto';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { ModelConfig } from '../../../shared/contract';
import { ConcurrencyGate } from './concurrencyGate';
import { BudgetTracker } from './budget';
import { handleRpc } from './primitives';
import { runScriptInWorker } from './sandbox';
import type { ScriptRunContext } from './agentBridge';
import type { ScriptRunSpec, ScriptRunState, ScriptRunEvent } from './types';

/**
 * 宿主（/workflow 命令层）提供的依赖。与 toolContext / configService / toolResolver 的接驳
 * 全在这里实现并注入，runService 不直接依赖宿主类型，保持运行时解耦。
 */
export interface ScriptRunHostDeps {
  baseModelConfig: ModelConfig;
  resolveModelConfig: ScriptRunContext['resolveModelConfig'];
  deriveSubagentContext: ScriptRunContext['deriveSubagentContext'];
  defaultAgentTools: string[];
  emit?: (event: ScriptRunEvent) => void;
  signal?: AbortSignal;
}

interface ActiveRun {
  controller: AbortController;
  state: ScriptRunState;
}

const activeRuns = new Map<string, ActiveRun>();

/** 启动一次 dynamic-workflow run，阻塞到脚本结束/失败/取消，返回终态 state。 */
export async function startRun(spec: ScriptRunSpec, deps: ScriptRunHostDeps): Promise<ScriptRunState> {
  const scriptHash = createHash('sha256').update(spec.script).digest('hex').slice(0, 16);
  const controller = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const state: ScriptRunState = {
    runId: spec.runId,
    status: 'running',
    scriptHash,
    startedAt: Date.now(),
    agentCallCount: 0,
    tokensSpent: 0,
    phases: [],
  };
  activeRuns.set(spec.runId, { controller, state });

  const budget = new BudgetTracker(spec.budgetTokens ?? null);

  const emit = (event: ScriptRunEvent): void => {
    const title = event.data?.title;
    if (event.type === 'run:phase' && typeof title === 'string') {
      state.phases.push(title);
    }
    deps.emit?.(event);
  };

  const callCounter = { count: 0 };
  const ctx: ScriptRunContext = {
    runId: spec.runId,
    baseModelConfig: deps.baseModelConfig,
    resolveModelConfig: deps.resolveModelConfig,
    deriveSubagentContext: deps.deriveSubagentContext,
    defaultAgentTools: deps.defaultAgentTools,
    signal: controller.signal,
    gate: new ConcurrencyGate(SCRIPT_RUNTIME.GLOBAL_MAX_CONCURRENCY),
    emit,
    callCounter,
    budget,
    now: () => Date.now(),
  };

  // try/finally：worker/emit/handleRpc/abort 以 rejected promise 冒出时也必须清 activeRuns，
  // 否则 stale run 泄漏 + 后续 cancel/getRunState 串线（Codex audit R2 HIGH）。
  try {
    emit({ runId: spec.runId, type: 'run:start', ts: Date.now(), data: { goal: spec.goal, scriptHash } });

    const outcome = await runScriptInWorker({
      script: spec.script,
      goal: spec.goal,
      budgetTotal: budget.total,
      signal: controller.signal,
      onRpc: (req) => handleRpc(req, ctx),
    });

    state.finishedAt = Date.now();
    state.agentCallCount = callCounter.count;
    state.tokensSpent = budget.spent();
    if (outcome.ok) {
      state.status = 'completed';
      state.result = outcome.result;
      emit({ runId: spec.runId, type: 'run:done', ts: Date.now(), data: { result: outcome.result } });
    } else {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      state.error = outcome.error;
      emit({ runId: spec.runId, type: 'run:error', ts: Date.now(), data: { error: outcome.error } });
    }
    return state;
  } finally {
    activeRuns.delete(spec.runId);
  }
}

/** 取消一个进行中的 run。返回是否命中。 */
export function cancelRun(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** 读取进行中 run 的状态快照（已结束的 run 不再保留于此）。 */
export function getRunState(runId: string): ScriptRunState | undefined {
  return activeRuns.get(runId)?.state;
}
