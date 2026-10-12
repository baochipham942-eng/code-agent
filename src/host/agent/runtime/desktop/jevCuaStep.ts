// ============================================================================
// Jev CUA step loop — computer_use execute_goal inner ring, fail-closed
// ============================================================================
// N-JEV-CU-STEP-LOOP. Spec: docs/architecture/designs/jev-cu-step.md ①⑧⑨⑩.
// Shape mirrors src/host/agent/runtime/browser/jevBrowserStep.ts (budget/step
// caps, sticky fallback, unarmed handling); the question set is the separate
// CU_* group. Non-negotiable rules baked into this loop:
//
// - Every act is dispatched back through the stateful handler's own execute
//   path, so the existing per-act `canUseTool` (dangerous_command) approval is
//   never skipped — including low-risk acts. Jev can only UPGRADE an approval
//   to forceConfirm, never grant one.
// - Jev acts are elementRef-only with explicit deliveryMode:"background".
//   No point, no screenshotId, no foreground retry, no stateId reuse.
// - empty AX tree hands the observe+screenshot back (reason "empty_ax") with
//   zero Jev and zero quickTask calls; a filtered-empty-but-raw-nonempty
//   window hands back without authorizing a coordinate click.
// - Any fallback is sticky for the rest of the task; no key / call error /
//   bad shape / confidence < 0.6 all hand back to today's main-model flow.

import type {
  ComputerUseActionResultV1,
  ComputerUseMutationV1,
  ComputerUseRootRefV1,
  ComputerUseStateViewV1,
} from '../../../../shared/contract/desktop';
import type { TurnCostEstimateInput } from '../../../../shared/contract/turnCost';
import {
  CU_STEP_OPERATIONS,
  CU_STEP_THRESHOLDS,
  CU_TARGET_NONE,
  buildCuStepQuestions,
  estimateJevCallUsd,
  isCuaJevStepEnabled,
  type CuStepOperation,
  type JevAnswers,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevSystemOneCall,
  JEV_MODEL,
} from '../../../../shared/constants/jevQuestions';
import { resolveJevRoute } from '../../../model/providers/typesafeProvider';
import type { ToolContext, ToolResult } from '../../../protocol/tools';
import {
  CU_RISK_KEYWORD,
  prepareCuJevCandidates,
  selectCuRootWindow,
} from './jevCuaStepCandidates';

const CUA_JEV_SOFT_STEP_LIMIT = 20;
const CUA_JEV_HARD_STEP_LIMIT = 60;
const CUA_JEV_TIME_LIMIT_MS = 100_000;
const CUA_JEV_DEFAULT_BUDGET_USD = 0.03;

/**
 * 元素型 choice：必须给出 targets 里的真实 ref。scroll 也在内——适配器对
 * 无 elementRef 的 scroll 直接 invalid_request（⑨ 生产 act 只走 elementRef）。
 */
const CUA_ELEMENT_OPERATIONS: ReadonlySet<CuStepOperation> = new Set([
  'click',
  'double_click',
  'set_value',
  'type_text',
  'scroll_up',
  'scroll_down',
  'scroll_left',
  'scroll_right',
]);
/** 可以带 elementRef 的 choice（press_key 适配器接受元素令牌，可无元素）。 */
const CUA_OPTIONAL_ELEMENT_OPERATIONS: ReadonlySet<CuStepOperation> = new Set([
  'press_return',
  'press_tab',
  'press_escape',
]);
/** 会改窗口状态的操作：审批升级只对这批生效（stop/scroll 不产生写入面）。 */
const CUA_INPUT_OPERATIONS: ReadonlySet<CuStepOperation> = new Set([
  ...CUA_ELEMENT_OPERATIONS,
  ...CUA_OPTIONAL_ELEMENT_OPERATIONS,
]);

const CUA_JEV_MISSING_KEY_WARN =
  'CODE_AGENT_CUA_JEV_STEP is on but no typesafe/OpenRouter key resolves; the desktop step loop stays unarmed (main model observes then acts)';

/** 环内 observe/act 的通道：必须回到有状态 handler 的执行路径，不许直连适配器。 */
export type CuaJevStepDispatch = (
  args: Record<string, unknown>,
  gate?: { forceConfirm?: boolean },
) => Promise<ToolResult<string>>;

interface CuaJevStepRunInput {
  task?: string;
  target?: { pid: number; windowId: number };
  jevBudgetUsd?: number;
}

export interface CuaJevStepDriver {
  run(input: CuaJevStepRunInput, context: ToolContext): Promise<ToolResult<string>>;
}

export interface CuaJevStepDeps {
  systemOne?: JevSystemOneCall;
  quickType?: (prompt: string) => Promise<string | null>;
  now?: () => number;
  /** 每次决断往 turn_cost_estimates 插一行；缺省走生产 DB。 */
  recordCost?: (input: TurnCostEstimateInput) => void | Promise<void>;
  /** key 解析注入口（单测用）；缺省 resolveJevRoute。 */
  keyRoute?: () => { model: string } | null;
}

interface CuaJevStepHandback {
  state?: ComputerUseStateViewV1;
  imageBase64?: string;
  roots?: ComputerUseRootRefV1[];
}

type CuaJevStepStatus =
  | 'done_verified'
  | 'fallback'
  | 'needs_review'
  | 'step_limit'
  | 'time_limit';

interface CuaJevStepResult {
  status: CuaJevStepStatus;
  fallback: boolean;
  reason?: string;
  jevCalls: number;
  jevUsd: number;
  jevChars: number;
  steps: number;
  doneSignals: number;
  handback: CuaJevStepHandback;
}

/** 交回后粘住：同一任务（sessionId + task）后续不再进 Jev。 */
const stickyTasks = new Map<string, true>();
const STICKY_TASK_LIMIT = 256;
let missingKeyWarned = false;

function stickyKey(context: ToolContext, task: string): string {
  return `${context.sessionId ?? 'anon'}::${task.trim().slice(0, 200)}`;
}

function markSticky(key: string): void {
  stickyTasks.delete(key);
  while (stickyTasks.size >= STICKY_TASK_LIMIT) {
    const oldest = stickyTasks.keys().next().value;
    if (oldest === undefined) break;
    stickyTasks.delete(oldest);
  }
  stickyTasks.set(key, true);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function choiceAnswer(answer: JevAnswers[string] | undefined): JevChoiceAnswer | null {
  if (!answer || typeof answer !== 'object' || !('choice' in answer)) return null;
  const { choice, confidence } = answer as JevChoiceAnswer;
  return typeof choice === 'string' && isUnitInterval(confidence) ? { choice, confidence } : null;
}

function noulAnswer(answer: JevAnswers[string] | undefined): JevNoulAnswer | null {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) return null;
  const { noul } = answer as JevNoulAnswer;
  return isUnitInterval(noul) ? { noul } : null;
}

type AppliedCuJevAnswers =
  | {
    ok: true;
    operation: CuStepOperation;
    targetRef: string | null;
    mutationConfidence: number;
    doneNoul: number;
    riskNoul: number;
  }
  | { ok: false; reason: 'low_confidence' | 'bad_shape' | 'incompatible_target' };

function applyCuJevAnswers(args: {
  answers: JevAnswers;
  refs: ReadonlySet<string>;
}): AppliedCuJevAnswers {
  const mutation = choiceAnswer(args.answers.mutation);
  const target = choiceAnswer(args.answers.target);
  const done = noulAnswer(args.answers.done);
  const risk = noulAnswer(args.answers.risk);
  if (!mutation || !target || !done || !risk) {
    return { ok: false, reason: 'bad_shape', };
  }
  if (!Object.hasOwn(CU_STEP_OPERATIONS, mutation.choice)) {
    return { ok: false, reason: 'bad_shape' };
  }
  const operation = mutation.choice as CuStepOperation;
  if (mutation.confidence < CU_STEP_THRESHOLDS.minChoiceConfidence) {
    return { ok: false, reason: 'low_confidence' };
  }
  const needsElement = CUA_ELEMENT_OPERATIONS.has(operation);
  if (needsElement && target.confidence < CU_STEP_THRESHOLDS.minChoiceConfidence) {
    return { ok: false, reason: 'low_confidence' };
  }
  if (target.choice === CU_TARGET_NONE) {
    if (needsElement) return { ok: false, reason: 'incompatible_target' };
    return {
      ok: true,
      operation,
      targetRef: null,
      mutationConfidence: mutation.confidence,
      doneNoul: done.noul,
      riskNoul: risk.noul,
    };
  }
  if (!args.refs.has(target.choice)) {
    return { ok: false, reason: needsElement ? 'incompatible_target' : 'bad_shape' };
  }
  return {
    ok: true,
    operation,
    targetRef: target.choice,
    mutationConfidence: mutation.confidence,
    doneNoul: done.noul,
    riskNoul: risk.noul,
  };
}

function resolveBudgetUsd(input: CuaJevStepRunInput): number {
  if (typeof input.jevBudgetUsd === 'number' && Number.isFinite(input.jevBudgetUsd) && input.jevBudgetUsd > 0) {
    return input.jevBudgetUsd;
  }
  const envRaw = process.env.CODE_AGENT_CUA_JEV_USD_BUDGET;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return CUA_JEV_DEFAULT_BUDGET_USD;
}

/** 焦点被抢走：驱动 0.14.2 的两条已知文案（⑩ 表：前台被换掉 ⇒ 失败交回，不重试）。 */
const FOCUS_STOLEN_PATTERN = /different app to become frontmost|self_activation_suppressed/i;

function parseObserveResponse(result: ToolResult<string>): {
  state: ComputerUseStateViewV1;
  imageBase64?: string;
} | null {
  const payload = result.ok ? result.output : result.error;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const state = (parsed as { state?: unknown })?.state;
  if (!state || typeof state !== 'object' || !('stateId' in state)) return null;
  return {
    state: state as ComputerUseStateViewV1,
    ...(typeof result.meta?.imageBase64 === 'string'
      ? { imageBase64: result.meta.imageBase64 }
      : {}),
  };
}

function parseRootsResponse(result: ToolResult<string>): ComputerUseRootRefV1[] | null {
  const payload = result.ok ? result.output : result.error;
  try {
    const parsed = JSON.parse(payload) as { roots?: unknown };
    return Array.isArray(parsed.roots) ? (parsed.roots as ComputerUseRootRefV1[]) : [];
  } catch {
    return null;
  }
}

function actionResultFrom(result: ToolResult<string>): ComputerUseActionResultV1 | null {
  const fromMeta = result.meta?.computerUseActionResultV1;
  if (fromMeta && typeof fromMeta === 'object') {
    return fromMeta as ComputerUseActionResultV1;
  }
  const payload = result.ok ? result.output : result.error;
  try {
    const parsed = JSON.parse(payload) as { result?: unknown };
    return parsed.result && typeof parsed.result === 'object' && 'overall' in parsed.result
      ? (parsed.result as ComputerUseActionResultV1)
      : null;
  } catch {
    return null;
  }
}

/** choice → 适配器 mutation（⑨ 的映射表；表里没有坐标点击/hotkey/drag）。 */
function buildCuMutation(
  operation: CuStepOperation,
  targetRef: string | null,
  value?: string,
): ComputerUseMutationV1 {
  if (operation === 'click' || operation === 'double_click') {
    return { kind: operation, elementRef: targetRef ?? undefined, deliveryMode: 'background' };
  }
  if (operation === 'set_value' || operation === 'type_text') {
    return {
      kind: operation,
      elementRef: targetRef ?? undefined,
      ...(value === undefined ? {} : { value }),
      deliveryMode: 'background',
    };
  }
  if (operation.startsWith('scroll_')) {
    return {
      kind: 'scroll',
      direction: operation.slice('scroll_'.length) as 'up' | 'down' | 'left' | 'right',
      ...(targetRef ? { elementRef: targetRef } : {}),
      deliveryMode: 'background',
    };
  }
  // press_return / press_tab / press_escape —— 映射表只有这三枚 key；
  // 别的 key 不存在 choice，坏答案在 applyCuJevAnswers 已被拒。
  return {
    kind: 'press_key',
    key: operation.slice('press_'.length),
    ...(targetRef ? { elementRef: targetRef } : {}),
    deliveryMode: 'background',
  };
}

async function generateCuTypeValue(
  task: string,
  fieldLabel: string,
  quickType: (prompt: string) => Promise<string | null> | null,
): Promise<string | null> {
  const prompt = [
    'Generate only the literal value to type into the field. No quotes, no explanation.',
    `Task: ${task.slice(0, 500)}`,
    `Field: ${fieldLabel}`,
  ].join('\n');
  return quickType(prompt);
}

async function runCuaJevStepLoop(
  input: CuaJevStepRunInput,
  context: ToolContext,
  deps: {
    dispatch: CuaJevStepDispatch;
    systemOne: JevSystemOneCall;
    quickType?: (prompt: string) => Promise<string | null>;
    now: () => number;
    recordCost?: (input: TurnCostEstimateInput) => void | Promise<void>;
  },
): Promise<CuaJevStepResult> {
  const now = deps.now;
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  const key = stickyKey(context, task || '(empty)');
  const started = now();
  const budgetUsd = resolveBudgetUsd(input);
  let spentUsd = 0;
  let jevCalls = 0;
  let jevChars = 0;
  let steps = 0;
  let doneSignals = 0;
  const recentSteps: Array<{ op: string; target_name: string; result: string }> = [];

  const finish = (
    status: CuaJevStepStatus,
    reason: string | undefined,
    handback: CuaJevStepHandback = {},
  ): CuaJevStepResult => {
    if (status === 'fallback') markSticky(key);
    return {
      status,
      fallback: status === 'fallback',
      reason,
      jevCalls,
      jevUsd: spentUsd,
      jevChars,
      steps,
      doneSignals,
      handback,
    };
  };

  if (!task) return finish('fallback', 'empty_task');
  if (stickyTasks.has(key)) return finish('fallback', 'sticky');

  const recordCost = async (row: TurnCostEstimateInput): Promise<void> => {
    if (!deps.recordCost) return;
    try {
      await deps.recordCost(row);
    } catch (error) {
      context.logger.warn('cua jev step cost ledger write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ── 根窗口选择（①：Jev 不选 App；0 或 >1 匹配交回并带根列表）──
  const rootsResult = await deps.dispatch({
    operation: 'list_roots',
    ...(input.target ? {} : { onScreenOnly: true }),
  });
  if (!rootsResult.ok) return finish('fallback', `list_roots_failed: ${rootsResult.error}`);
  const roots = parseRootsResponse(rootsResult);
  if (roots === null) return finish('fallback', 'list_roots_failed: unparseable response');
  const selection = selectCuRootWindow({ roots, task, target: input.target });
  if (!selection.root) {
    return finish('fallback', `root_${selection.reason}`, { roots: selection.handbackRoots });
  }
  const rootTarget = { pid: selection.root.pid, windowId: selection.root.windowId };

  let state: ComputerUseStateViewV1 | undefined;
  let stateImage: string | undefined;

  while (steps < CUA_JEV_HARD_STEP_LIMIT) {
    if (context.abortSignal.aborted) return finish('fallback', 'aborted');
    if (now() - started >= CUA_JEV_TIME_LIMIT_MS) return finish('time_limit', 'time_limit');
    if (steps >= CUA_JEV_SOFT_STEP_LIMIT) return finish('step_limit', 'step_limit');

    if (!state) {
      const observed = await deps.dispatch({ operation: 'observe', target: rootTarget });
      if (!observed.ok) return finish('fallback', `observe_failed: ${observed.error}`);
      const parsed = parseObserveResponse(observed);
      if (!parsed) return finish('fallback', 'observe_failed: unparseable response');
      state = parsed.state;
      stateImage = parsed.imageBase64;
    }

    // 空树（⑨）：不进 Jev、不进快模型，交回本次 observe+截图，主模型走 point 路径。
    if (state.elements.length === 0) {
      return finish('fallback', 'empty_ax', { state, imageBase64: stateImage });
    }

    const prepared = prepareCuJevCandidates(state.elements, task);
    // 过滤后空、原始非空（③-A）：整窗交回，且不授权点选——点选会打在被排除的控件上。
    if (prepared.candidates.length === 0) {
      return finish('fallback', 'no_candidates', { state, imageBase64: stateImage });
    }

    const targets: Record<string, unknown> = {};
    for (const candidate of prepared.candidates) {
      targets[candidate.ref] = {
        role: candidate.role,
        label: candidate.label,
        depth: candidate.depth,
        ...(candidate.parentRef ? { parent_ref: candidate.parentRef } : {}),
        has_value: candidate.hasValue,
      };
    }
    const recent: Record<string, unknown> = {};
    recentSteps.slice(-8).forEach((step, index) => {
      recent[`s${index + 1}`] = step;
    });
    const jevState = {
      task: task.slice(0, 2_000),
      window: {
        app: state.root.appName ?? '',
        title: (state.root.title ?? '').slice(0, 500),
        truncated: prepared.filteredCount > prepared.candidates.length,
      },
      targets,
      recent_steps: recent,
      flags: { sensitive_fields_present: prepared.sensitiveFieldsPresent },
    };
    const questions = buildCuStepQuestions(prepared.labels);
    const stateChars = JSON.stringify(jevState).length;
    const questionChars = JSON.stringify(questions).length;
    const nextUsd = estimateJevCallUsd(stateChars, questionChars);
    if (spentUsd + nextUsd > budgetUsd) {
      return finish('fallback', 'budget', { state, imageBase64: stateImage });
    }

    let answers: JevAnswers;
    try {
      answers = await deps.systemOne(jevState, questions, { signal: context.abortSignal });
    } catch {
      if (context.abortSignal.aborted) return finish('fallback', 'aborted');
      return finish('fallback', 'jev_error', { state, imageBase64: stateImage });
    }
    jevCalls += 1;
    jevChars += stateChars + questionChars;
    spentUsd += nextUsd;
    // 每次决断一行刊例账：provider typesafe、model JEV_MODEL、input=ceil(chars/4)、
    // output 0、usd=estimateJevCallUsd、source 不冒充目录价（枚举无「刊例估算」档）。
    await recordCost({
      sessionId: context.sessionId,
      provider: 'typesafe',
      modelId: JEV_MODEL,
      inputTokens: Math.ceil((stateChars + questionChars) / 4),
      outputTokens: 0,
      usd: nextUsd,
      source: 'unknown',
    });

    const applied = applyCuJevAnswers({
      answers,
      refs: new Set(prepared.candidates.map((candidate) => candidate.ref)),
    });
    if (!applied.ok) {
      return finish('fallback', applied.reason, { state, imageBase64: stateImage });
    }

    // done 只记账：不构成终止（⑤(a) 变异钉死）。
    if (applied.doneNoul >= CU_STEP_THRESHOLDS.doneSignalLog) doneSignals += 1;

    if (applied.operation === 'stop') {
      // 环自己的证据 = stop choice（置信度已过地板）与 done 信号同时成立。
      if (applied.doneNoul >= CU_STEP_THRESHOLDS.doneSignalLog) {
        return finish('done_verified', undefined, { state, imageBase64: stateImage });
      }
      return finish('fallback', 'stop_unverified', { state, imageBase64: stateImage });
    }

    const candidate = applied.targetRef
      ? prepared.candidates.find((entry) => entry.ref === applied.targetRef) ?? null
      : null;
    const targetName = candidate?.label ?? '';

    let value: string | undefined;
    if (applied.operation === 'set_value' || applied.operation === 'type_text') {
      const generated = deps.quickType
        ? await generateCuTypeValue(task, targetName, deps.quickType)
        : null;
      if (generated == null) {
        return finish('fallback', 'type_value_unavailable', { state, imageBase64: stateImage });
      }
      value = generated;
    }

    const mutation = buildCuMutation(applied.operation, applied.targetRef, value);
    const riskHit = applied.riskNoul >= CU_STEP_THRESHOLDS.riskUpgrade
      || CU_RISK_KEYWORD.test(targetName);
    const forceConfirm = riskHit && CUA_INPUT_OPERATIONS.has(applied.operation);

    const acted = await deps.dispatch(
      {
        operation: 'act',
        stateId: state.stateId,
        mutation,
      },
      { forceConfirm },
    );
    if (!acted.ok && acted.code === 'PERMISSION_DENIED') {
      // 审批被拒：人已裁决，Jev 无权再驱动；交回主模型（不粘住，浏览器先例）。
      return finish('needs_review', 'SURFACE_APPROVAL_REQUIRED', {
        state,
        imageBase64: stateImage,
      });
    }

    const actionResult = actionResultFrom(acted);
    if (actionResult?.overall === 'ambiguous') {
      // 投递不确定（⑩ unverifiable）：不当成功，不升 foreground，交回核对。
      return finish('fallback', 'delivery_unverified', { state, imageBase64: stateImage });
    }
    if (!acted.ok) {
      const kind = actionResult?.error?.kind;
      const message = actionResult?.error?.message ?? acted.error;
      if (FOCUS_STOLEN_PATTERN.test(message)) {
        return finish('fallback', 'focus_stolen', { state, imageBase64: stateImage });
      }
      if (kind === 'provider_restarted') {
        return finish('fallback', 'provider_restarted', { state, imageBase64: stateImage });
      }
      if (kind === 'stale_state' || kind === 'state_conflict' || kind === 'target_missing') {
        // 单次绑定被拒：绝不复用旧 stateId，也不换 ref 再打同一个 id。
        return finish('fallback', 'stale_state', { state, imageBase64: stateImage });
      }
      return finish('fallback', `act_failed: ${kind ?? message}`, {
        state,
        imageBase64: stateImage,
      });
    }

    recentSteps.push({
      op: applied.operation,
      target_name: targetName,
      result: actionResult?.overall ?? 'delivered_unverified',
    });
    steps += 1;

    // act 自带新 observe（successor）：直接作为下一步 state，不再显式 observe，
    // 否则会把刚拿到的 successor 标成 superseded（设计稿 ①）。
    const successor = actionResult?.successorState;
    if (successor) {
      state = successor;
      if (typeof acted.meta?.imageBase64 === 'string') stateImage = acted.meta.imageBase64;
    } else {
      const observed = await deps.dispatch({ operation: 'observe', target: rootTarget });
      const parsed = observed.ok ? parseObserveResponse(observed) : null;
      if (!parsed) return finish('fallback', 'successor_observe_failed');
      state = parsed.state;
      stateImage = parsed.imageBase64;
    }
  }

  return finish('step_limit', 'step_limit');
}

function toToolResult(result: CuaJevStepResult): ToolResult<string> {
  const success = result.status === 'done_verified'
    || (result.status === 'fallback' && result.reason !== 'empty_task' && result.reason !== 'aborted');
  const payload = {
    version: 1 as const,
    operation: 'execute_goal' as const,
    result: {
      status: result.status,
      fallback: result.fallback,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      steps: result.steps,
      jev_calls: result.jevCalls,
      jev_usd: result.jevUsd,
      done_signals: result.doneSignals,
      ...(result.handback.roots ? { roots: result.handback.roots } : {}),
      ...(result.handback.state ? { observe: result.handback.state } : {}),
    },
  };
  const body = JSON.stringify(payload);
  const meta = {
    cuaJevStepV1: {
      status: result.status,
      fallback: result.fallback,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      jevCalls: result.jevCalls,
      jevUsd: result.jevUsd,
      jevChars: result.jevChars,
      steps: result.steps,
      doneSignals: result.doneSignals,
    },
    ...(result.handback.state ? { computerUseStateV1: result.handback.state } : {}),
    ...(result.handback.imageBase64 ? { imageBase64: result.handback.imageBase64 } : {}),
  };
  if (success) return { ok: true, output: body, meta };
  return {
    ok: false,
    error: body,
    code: result.status === 'needs_review' ? 'SURFACE_APPROVAL_REQUIRED' : 'CUA_JEV_STEP_HANDOFF',
    meta,
  };
}

/** 生产刊例账落库（设计稿·成本推荐 A）：动态导入避免单测拖起 DB。 */
async function defaultRecordCost(row: TurnCostEstimateInput): Promise<void> {
  const { getDatabase } = await import('../../../services/core/databaseService');
  getDatabase().getTurnCostRepo().insert(row);
}

/** 生产写文本：quickTask（快模型），提示词只含任务摘要 + 控件 label，无 AX value。 */
function defaultQuickType(context: ToolContext): (prompt: string) => Promise<string | null> {
  return async (prompt) => {
    const { quickTask } = await import('../../../model/quickModel');
    const generated = await quickTask(prompt, 64, context.abortSignal);
    return generated.success ? (generated.content || '').trim() || null : null;
  };
}

function createCuaJevStepDriver(
  dispatch: CuaJevStepDispatch,
  deps: CuaJevStepDeps & { systemOne: JevSystemOneCall },
): CuaJevStepDriver {
  return {
    async run(input, context) {
      const result = await runCuaJevStepLoop(input, context, {
        dispatch,
        systemOne: deps.systemOne,
        now: deps.now ?? Date.now,
        quickType: deps.quickType ?? defaultQuickType(context),
        recordCost: deps.recordCost ?? defaultRecordCost,
      });
      return toToolResult(result);
    },
  };
}

/**
 * 装配点：CODE_AGENT_CUA_JEV_STEP=1 才装配；注入 systemOne（单测）直接武装，
 * 否则要求 typesafe/OpenRouter key 可解析（resolveJevRoute），无 key 不装配。
 */
export function resolveCuaJevStep(
  dispatch: CuaJevStepDispatch,
  deps: CuaJevStepDeps = {},
): CuaJevStepDriver | undefined {
  if (!isCuaJevStepEnabled()) return undefined;
  const injected = deps.systemOne;
  if (injected) return createCuaJevStepDriver(dispatch, { ...deps, systemOne: injected });
  const route = (deps.keyRoute ?? resolveJevRoute)();
  if (!route) {
    if (!missingKeyWarned) {
      console.warn(CUA_JEV_MISSING_KEY_WARN);
      missingKeyWarned = true;
    }
    return undefined;
  }
  const lazySystemOne: JevSystemOneCall = (state, questions, options) =>
    import('../../../model/providers/typesafeProvider').then((mod) =>
      mod.systemOne(state, questions, options));
  return createCuaJevStepDriver(dispatch, { ...deps, systemOne: lazySystemOne });
}

export function cuaJevStepUnarmedResult(): ToolResult<string> {
  return {
    ok: false,
    error: 'Desktop Jev step loop is not armed (CODE_AGENT_CUA_JEV_STEP off or no typesafe key); use list_roots / observe / act yourself',
    code: 'CUA_JEV_STEP_UNARMED',
    meta: { cuaJevStepV1: { status: 'fallback', fallback: true, reason: 'unarmed' } },
  };
}

export function cuaJevStepEmptyTaskResult(): ToolResult<string> {
  return {
    ok: false,
    error: 'execute_goal requires a non-empty task',
    code: 'INVALID_ARGS',
    meta: { cuaJevStepV1: { status: 'fallback', fallback: true, reason: 'empty_task' } },
  };
}
