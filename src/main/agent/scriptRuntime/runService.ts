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
import { SerialWriteGate } from './writeGate';
import type { ScriptRunContext } from './agentBridge';
import type { RunStatus, ScriptRunCallRecord, ScriptRunSpec, ScriptRunState, ScriptRunEvent } from './types';

/**
 * resumable journal 网关（持久化解耦）：runService 只认这个接口，真实落地（SQLite）由命令层
 * 用 WorkflowJournalRepository 注入；DB 未就绪时命令层注入 undefined → 全 live 跑、不持久化。
 */
export interface ScriptRunPriorJournal {
  run: {
    runId: string;
    scriptHash: string;
    goal?: string | null;
    inputHash?: string | null;
  };
  calls: Map<number, { contentHash: string; result: ScriptRunCallRecord['result'] }>;
}

export interface ScriptRunJournal {
  /** 载入被 resume 的旧 run 元数据与逐调用缓存；有实现时优先于 loadPriorCalls。 */
  loadPriorRun?(runId: string): ScriptRunPriorJournal | null;
  /** 载入被 resume 的旧 run 的逐调用缓存（callIndex → {contentHash, result}）；无则 null。 */
  loadPriorCalls(runId: string): Map<number, { contentHash: string; result: ScriptRunCallRecord['result'] }> | null;
  /** 本 run 开始：写 running 占位（必须先于任何 onCallComplete，FK 父行）。 */
  onRunStart(input: { runId: string; scriptHash: string; goal?: string; inputHash: string; startedAt: number }): void;
  /** 本 run 收尾：写终态 + 结果/错误 + 累计 token。 */
  onRunFinish(input: { runId: string; status: RunStatus; finishedAt: number; tokensSpent: number; result?: unknown; error?: string }): void;
  /** 记录一次成功调用（命中或 live）到本 run journal。 */
  onCallComplete(input: { runId: string } & ScriptRunCallRecord): void;
}

/**
 * 宿主（/workflow 命令层）提供的依赖。与 toolContext / configService / toolResolver 的接驳
 * 全在这里实现并注入，runService 不直接依赖宿主类型，保持运行时解耦。
 */
export interface ScriptRunHostDeps {
  baseModelConfig: ModelConfig;
  resolveModelConfig: ScriptRunContext['resolveModelConfig'];
  deriveSubagentContext: ScriptRunContext['deriveSubagentContext'];
  resolveAgentTools: ScriptRunContext['resolveAgentTools'];
  emit?: (event: ScriptRunEvent) => void;
  signal?: AbortSignal;
  /** resumable 持久化网关（缺省 = 不持久化、不重放）。 */
  journal?: ScriptRunJournal;
}

interface ActiveRun {
  controller: AbortController;
  state: ScriptRunState;
}

const activeRuns = new Map<string, ActiveRun>();

function computeRunInputHash(spec: Pick<ScriptRunSpec, 'goal'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ goal: spec.goal ?? null }))
    .digest('hex')
    .slice(0, 16);
}

/** 启动一次 dynamic-workflow run，阻塞到脚本结束/失败/取消，返回终态 state。 */
export async function startRun(spec: ScriptRunSpec, deps: ScriptRunHostDeps): Promise<ScriptRunState> {
  const scriptHash = createHash('sha256').update(spec.script).digest('hex').slice(0, 16);
  const runInputHash = computeRunInputHash(spec);
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
    cacheHits: 0,
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

  // resumable：从旧 run 的 journal 载入逐调用缓存（仅当指定 resumeFromRunId 且有 journal）。
  // best-effort（Codex round1 HIGH#3）：journal 读异常不得拖垮 run，捕获后退化成全 live。
  const journal = deps.journal;
  let resumeCalls: ScriptRunContext['resumeCalls'];
  let resumeInputMismatchMessage: string | undefined;
  if (spec.resumeFromRunId && journal) {
    try {
      if (journal.loadPriorRun) {
        const prior = journal.loadPriorRun(spec.resumeFromRunId);
        if (prior) {
          const priorInputHash = prior.run.inputHash ?? computeRunInputHash({ goal: prior.run.goal ?? undefined });
          if (priorInputHash === runInputHash) {
            resumeCalls = prior.calls;
          } else {
            resumeInputMismatchMessage =
              `⚠️ resume 源 run「${spec.resumeFromRunId}」的 goal/args 上下文与本次不同，本次全量 live 重跑（不命中缓存、照常计费）`;
          }
        }
      } else {
        resumeCalls = journal.loadPriorCalls(spec.resumeFromRunId) ?? undefined;
      }
    } catch {
      resumeCalls = undefined;
    }
  }
  // 把成功调用写进【本 run】journal（命中拷贝 + live 记录都走这里），便于后续链式 resume。
  // best-effort：写库异常被吞，绝不反噬已成功的 agent 调用（token 已花，不能因写库失败翻成失败）。
  const recordCall = journal
    ? (record: ScriptRunCallRecord): void => {
        try {
          journal.onCallComplete({ runId: spec.runId, ...record });
        } catch {
          /* best-effort journal — 不抛 */
        }
      }
    : undefined;

  const callCounter = { count: 0 };
  const cacheHitCounter = { count: 0 };
  const ctx: ScriptRunContext = {
    runId: spec.runId,
    runInputHash,
    baseModelConfig: deps.baseModelConfig,
    resolveModelConfig: deps.resolveModelConfig,
    deriveSubagentContext: deps.deriveSubagentContext,
    resolveAgentTools: deps.resolveAgentTools,
    writeGuard: { inFlight: 0, warned: false },
    writeGate: new SerialWriteGate(),
    signal: controller.signal,
    gate: new ConcurrencyGate(SCRIPT_RUNTIME.GLOBAL_MAX_CONCURRENCY),
    emit,
    callCounter,
    cacheHitCounter,
    budget,
    now: () => Date.now(),
    resumeCalls,
    recordCall,
  };

  // try/finally：worker/emit/handleRpc/abort 以 rejected promise 冒出时也必须清 activeRuns，
  // 否则 stale run 泄漏 + 后续 cancel/getRunState 串线（Codex audit R2 HIGH）。
  try {
    emit({ runId: spec.runId, type: 'run:start', ts: Date.now(), data: { goal: spec.goal, scriptHash } });
    // journal 父行先于任何 onCallComplete 写入（FK + resume 自包含）；best-effort 不阻断执行。
    try {
      journal?.onRunStart({ runId: spec.runId, scriptHash, goal: spec.goal, inputHash: runInputHash, startedAt: state.startedAt });
    } catch {
      /* best-effort journal — 不抛 */
    }
    // MED-3：resume 请求但没拿到任何缓存（runId 笔误 / journal 不可用 / 旧 run 没记调用）→ 不静默
    // 退化烧预算，发一条 run:log 警告让调用方看见「这次没命中、在全量 live 跑」。
    if (resumeInputMismatchMessage) {
      try {
        emit({
          runId: spec.runId,
          type: 'run:log',
          ts: Date.now(),
          data: { message: resumeInputMismatchMessage },
        });
      } catch {
        /* 观测面非权威，不反噬执行 */
      }
    } else if (spec.resumeFromRunId && (!resumeCalls || resumeCalls.size === 0)) {
      // 纯观测警告——必须 best-effort（Codex round2 MED#3）：host emit 抛错不得在执行前中断 run。
      try {
        emit({
          runId: spec.runId,
          type: 'run:log',
          ts: Date.now(),
          data: { message: `⚠️ resume 请求的 run「${spec.resumeFromRunId}」无可用 journal，本次全量 live 重跑（不命中缓存、照常计费）` },
        });
      } catch {
        /* 观测面非权威，不反噬执行 */
      }
    }

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
    state.cacheHits = cacheHitCounter.count;
    // terminal emit 是观测层，且发生在权威结果已定之后——必须 best-effort（Codex round3 MED）：
    // run:done/run:error emit 抛错不得顶替 `return state`（否则成功 run 被 emit 错变成 reject、
    // 脚本真错被 emit 错盖掉）。run:start 的 fatal 合同保留不动（见 runService.test 既定契约）。
    if (outcome.ok) {
      state.status = 'completed';
      state.result = outcome.result;
      try {
        emit({ runId: spec.runId, type: 'run:done', ts: Date.now(), data: { result: outcome.result } });
      } catch {
        /* 观测面非权威，不反噬权威结果 */
      }
    } else {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      state.error = outcome.error;
      try {
        emit({ runId: spec.runId, type: 'run:error', ts: Date.now(), data: { error: outcome.error } });
      } catch {
        /* 观测面非权威，不盖掉脚本真错 */
      }
    }
    return state;
  } finally {
    // onRunFinish 放 finally + 独立 try/catch（Codex round1 HIGH#3）：即便终态 emit 抛错也保证
    // 终态落库，status 不会永卡 'running'；journal 写异常也不得吞掉 run 的真实结果/抛出。
    if (state.finishedAt === undefined) state.finishedAt = Date.now();
    // 异常路径（执行前 emit 抛错 / worker 异常冒出）会让 status 残留 'running'；规整成终态再落库
    // （Codex round2 MED#3），否则 journal 会把已中断的 run 永久记成 running。
    if (state.status === 'running') state.status = controller.signal.aborted ? 'cancelled' : 'failed';
    try {
      journal?.onRunFinish({
        runId: spec.runId,
        status: state.status,
        finishedAt: state.finishedAt,
        tokensSpent: state.tokensSpent,
        result: state.result,
        error: state.error,
      });
    } catch {
      /* best-effort journal — 不抛 */
    }
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
