// ============================================================================
// Jev browser step loop — execute_goal inner ring, fail-closed to main model
// ============================================================================

import {
  BROWSER_STEP_OPERATIONS,
  BROWSER_STEP_THRESHOLDS,
  BROWSER_TARGET_NONE,
  JEV_MODEL,
  buildBrowserStepQuestions,
  estimateJevCallUsd,
  isBrowserJevStepEnabled,
  type BrowserStepOperation,
  type JevAnswers,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevSystemOneCall,
} from '../../../../shared/constants/jevQuestions';
import { resolveProviderApiKey } from '../../../model/providers/providerResolution';
import { classifyBrowserComputerManualTakeover } from '../../../../shared/utils/browserComputerRedaction';
import type { BrowserService } from '../../../services/infra/browserService';
import { guardJevBrowserSnapshot, guardJevPromptText } from '../../../services/infra/browser/jevBrowserSnapshotGuard';
import {
  prepareJevBrowserSnapshot,
  type JevCandidate,
  type JevCapturedSnapshot,
  type PreparedJevSnapshot,
} from '../../../services/infra/browser/jevBrowserSnapshotPrep';
import type { BrowserTargetRef } from '../../../services/infra/browser/types';
import type { ToolContext, ToolExecutionResult } from '../../../tools/types';
import {
  evaluateJevAssertions,
  extractJevAssertions,
  pageFingerprint,
  type JevPageAssertion,
} from './jevBrowserAssertions';
import {
  createManagedJevBrowserHost,
  isBlockedSystemUrl,
  isStaleTargetRefError,
  type JevBrowserHost,
} from './jevBrowserHost';

const BROWSER_JEV_SOFT_STEP_LIMIT = 20;
const BROWSER_JEV_HARD_STEP_LIMIT = 60;
const BROWSER_JEV_TIME_LIMIT_MS = 100_000;
const BROWSER_JEV_DEFAULT_BUDGET_USD = 0.03;
const NO_PROGRESS_LIMIT = 3;
const RISK_KEYWORD = /pay|payment|checkout|购买|支付|delete|删除|authorize|oauth|授权|grant access|confirm purchase|unsubscribe/i;
const UPLOAD_TASK = /upload|上传|file|文件|传上/i;
const TASK_URL_RE = /https?:\/\/[^\s<>"'`)]+/i;
const LOGIN_WALL_COPY = /登录后继续|请先登录|请登录|需要登录|sign in to continue|log in to continue|please sign in|please log in|login required|sign in required|not signed in|authentication required|needs login/i;
const MANUAL_TAKEOVER_COPY = /manual takeover|user takeover|take over manually|requires manual|人工接管|用户接管/i;

const BROWSER_JEV_MISSING_KEY_WARN =
  'CODE_AGENT_BROWSER_JEV_STEP 已开启但 TYPESAFE_API_KEY 缺失，Jev 步选不生效（走主模型逐步 Browser）';

type BrowserJevMode = 'try_jev' | 'sticky_visual';
type JevBrowserStepStatus =
  | 'done_verified'
  | 'stalled'
  | 'step_limit'
  | 'time_limit'
  | 'needs_review'
  | 'fallback';

interface JevBrowserStepResult {
  status: JevBrowserStepStatus;
  fallback: boolean;
  reason?: string;
  browserJevMode: BrowserJevMode | 'unarmed';
  falseDoneCount: number;
  jevCalls: number;
  jevUsd: number;
  jevChars: number;
  steps: number;
  output: string;
  metadata: Record<string, unknown>;
}

interface JevBrowserStepRunInput {
  task?: string;
  assertions?: Array<JevPageAssertion | Record<string, unknown>>;
  jevBudgetUsd?: number;
  mutate?: 'done1' | 'empty-window';
  browserService?: BrowserService;
}

interface JevBrowserStepDriver {
  run(input: JevBrowserStepRunInput, context: ToolContext): Promise<ToolExecutionResult>;
}

interface JevBrowserStepLoopDeps {
  systemOne: JevSystemOneCall;
  host: JevBrowserHost;
  quickType?: (prompt: string) => Promise<string | null>;
  now?: () => number;
  mutate?: 'done1' | 'empty-window';
}

interface JevBrowserStepDriverDeps {
  systemOne: JevSystemOneCall;
  host?: JevBrowserHost;
  browserService?: BrowserService;
  quickType?: ((prompt: string) => Promise<string | null>) | null;
  now?: () => number;
  mutate?: 'done1' | 'empty-window';
}

interface TurnState {
  mode: BrowserJevMode;
  consecutiveJevFailures: number;
  emptyWindowRounds: number;
}

const turnStates = new Map<string, TurnState>();
const TURN_STATE_LIMIT = 256;
let missingKeyWarned = false;

function turnKey(context: ToolContext): string {
  return `${context.sessionId ?? 'anon'}::${context.turnId ?? context.runId ?? 'turn'}`;
}

function getTurnState(key: string): TurnState {
  const existing = turnStates.get(key);
  if (existing) {
    turnStates.delete(key);
    turnStates.set(key, existing);
    return existing;
  }
  while (turnStates.size >= TURN_STATE_LIMIT) {
    const oldest = turnStates.keys().next().value;
    if (oldest === undefined) break;
    turnStates.delete(oldest);
  }
  const created: TurnState = { mode: 'try_jev', consecutiveJevFailures: 0, emptyWindowRounds: 0 };
  turnStates.set(key, created);
  return created;
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

type AppliedJevAnswers =
  | {
    ok: true;
    operation: BrowserStepOperation;
    targetId: string | null;
    doneNoul: number;
    riskNoul: number;
    retryAsk: boolean;
  }
  | { ok: false; reason: 'low_confidence' | 'bad_shape' | 'incompatible_target'; retryAsk: boolean };

function applyJevAnswers(args: {
  answers: JevAnswers;
  windowIds: Set<string>;
  mutateDone1?: boolean;
}): AppliedJevAnswers {
  const operation = choiceAnswer(args.answers.operation);
  const target = choiceAnswer(args.answers.target);
  const done = noulAnswer(args.answers.done);
  const risk = noulAnswer(args.answers.risk);
  if (!operation || !target || !done || !risk) {
    return { ok: false, reason: 'bad_shape', retryAsk: false };
  }
  if (!Object.hasOwn(BROWSER_STEP_OPERATIONS, operation.choice)) {
    return { ok: false, reason: 'bad_shape', retryAsk: false };
  }
  let doneNoul = done.noul;
  if (args.mutateDone1) doneNoul = 1.0;
  const needsTarget = operation.choice === 'click' || operation.choice === 'type';
  if (operation.confidence < BROWSER_STEP_THRESHOLDS.minChoiceConfidence) {
    return { ok: false, reason: 'low_confidence', retryAsk: false };
  }
  if (needsTarget && target.confidence < BROWSER_STEP_THRESHOLDS.minChoiceConfidence) {
    return { ok: false, reason: 'low_confidence', retryAsk: false };
  }
  if (needsTarget && (target.choice === BROWSER_TARGET_NONE || !args.windowIds.has(target.choice))) {
    return { ok: false, reason: 'incompatible_target', retryAsk: true };
  }
  if (!needsTarget && target.choice !== BROWSER_TARGET_NONE && !args.windowIds.has(target.choice)) {
    return { ok: false, reason: 'bad_shape', retryAsk: false };
  }
  return {
    ok: true,
    operation: operation.choice as BrowserStepOperation,
    targetId: needsTarget ? target.choice : null,
    doneNoul,
    riskNoul: risk.noul,
    retryAsk: false,
  };
}

function resolveBudgetUsd(input: JevBrowserStepRunInput): number {
  if (typeof input.jevBudgetUsd === 'number' && Number.isFinite(input.jevBudgetUsd) && input.jevBudgetUsd > 0) {
    return input.jevBudgetUsd;
  }
  const envRaw = process.env.CODE_AGENT_BROWSER_JEV_USD_BUDGET;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return BROWSER_JEV_DEFAULT_BUDGET_USD;
}

function resolveSoftStepLimit(): number {
  const envRaw = process.env.CODE_AGENT_BROWSER_JEV_SOFT_STEP_LIMIT;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(Math.floor(parsed), BROWSER_JEV_HARD_STEP_LIMIT);
    }
  }
  return BROWSER_JEV_SOFT_STEP_LIMIT;
}

function extractTaskUrl(task: string): string | null {
  const match = task.match(TASK_URL_RE);
  return match ? match[0] : null;
}

function capturedHasPasswordOrForm(captured: JevCapturedSnapshot): boolean {
  if (captured.extras.some((extra) => {
    const type = (extra.inputType || '').toLowerCase();
    const auto = (extra.autocomplete || '').toLowerCase();
    return type === 'password' || auto.includes('password');
  })) return true;
  return captured.snapshot.interactiveElements.some((element) => {
    const tag = element.tag.toLowerCase();
    const role = (element.role || '').toLowerCase();
    return tag === 'form'
      || tag === 'input'
      || tag === 'textarea'
      || tag === 'select'
      || role === 'textbox'
      || role === 'searchbox'
      || role === 'combobox';
  });
}

function isJevLoginWall(captured: JevCapturedSnapshot, visibleText: string): boolean {
  const primary = [
    captured.snapshot.title,
    ...captured.snapshot.headings.map((heading) => heading.text),
    visibleText,
  ].join('\n');
  if (!LOGIN_WALL_COPY.test(primary)) return false;
  return capturedHasPasswordOrForm(captured);
}

function sameUrl(current: string, target: string): boolean {
  try {
    const left = new URL(current);
    const right = new URL(target);
    return left.origin === right.origin
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      && left.search === right.search;
  } catch {
    return current === target;
  }
}

function rebindTarget(prepared: PreparedJevSnapshot, previous: BrowserTargetRef): BrowserTargetRef | null {
  const previousTag = previous.selector?.split(/[#.[]/)[0]?.toLowerCase() || '';
  const match = prepared.collected.find((candidate) => (
    candidate.targetRef.name === previous.name
    && (candidate.role || null) === (previous.role || null)
    && previousTag !== ''
    && candidate.tag.toLowerCase() === previousTag
  ));
  return match?.targetRef ?? null;
}

async function evidenceFrom(host: JevBrowserHost, captured: JevCapturedSnapshot) {
  let formValues: Record<string, string> = {};
  let formValuesError: string | undefined;
  try {
    formValues = await host.getFormValues();
  } catch (error) {
    formValuesError = error instanceof Error ? error.message : String(error);
  }
  const downloads = await host.listDownloads();
  return {
    url: captured.snapshot.url,
    title: captured.snapshot.title,
    headings: captured.snapshot.headings,
    elements: captured.snapshot.interactiveElements.map((element) => ({
      text: element.text,
      ariaLabel: element.ariaLabel,
      name: element.targetRef.name || undefined,
      placeholder: element.placeholder,
      role: element.role,
      selectorHint: element.selectorHint,
    })),
    formValues,
    downloads,
    formValuesError,
  };
}

function toToolResult(result: JevBrowserStepResult): ToolExecutionResult {
  const success = result.status === 'done_verified'
    || (result.status === 'fallback' && result.reason !== 'empty_task' && result.reason !== 'aborted');
  return {
    success,
    output: result.output,
    error: success ? undefined : result.output,
    metadata: {
      ...result.metadata,
      status: result.status,
      fallback: result.fallback,
      reason: result.reason,
      browserJevMode: result.browserJevMode,
      false_done_count: result.falseDoneCount,
      jevCalls: result.jevCalls,
      jevUsd: result.jevUsd,
      jevChars: result.jevChars,
      steps: result.steps,
    },
  };
}

async function runJevBrowserStepLoop(
  input: JevBrowserStepRunInput,
  context: ToolContext,
  deps: JevBrowserStepLoopDeps,
): Promise<JevBrowserStepResult> {
  const key = turnKey(context);
  const turn = getTurnState(key);
  const started = (deps.now ?? Date.now)();
  const budgetUsd = resolveBudgetUsd(input);
  const mutate = deps.mutate ?? input.mutate;
  const softStepLimit = resolveSoftStepLimit();
  let spentUsd = 0;
  let jevCalls = 0;
  let jevChars = 0;
  let falseDoneCount = 0;
  let steps = 0;
  let consecutiveNoProgress = 0;
  let lastFingerprint = '';
  const recentSteps: Array<{ op: string; target_name: string; result: string }> = [];
  let truncatedWithoutScroll = 0;
  let incompatibleRetryUsed = false;
  let carriedSnapshot: JevCapturedSnapshot | undefined;
  let carriedPrepared: PreparedJevSnapshot | undefined;

  const finish = (
    status: JevBrowserStepStatus,
    reason: string | undefined,
    extra: Record<string, unknown> = {},
  ): JevBrowserStepResult => {
    const result: JevBrowserStepResult = {
      status,
      fallback: status === 'fallback',
      reason,
      browserJevMode: turn.mode,
      falseDoneCount,
      jevCalls,
      jevUsd: spentUsd,
      jevChars,
      steps,
      output: reason ? `Jev browser step ${status}: ${reason}` : `Jev browser step ${status}`,
      metadata: extra,
    };
    // Keep fallback entries so sticky_visual / consecutiveJevFailures survive a later execute_goal in this turn.
    if (status !== 'fallback') turnStates.delete(key);
    return result;
  };

  if (typeof input.task !== 'string' || !input.task.trim()) return finish('fallback', 'empty_task');
  const task = input.task;
  const assertions = extractJevAssertions(task, input.assertions);

  if (turn.mode === 'sticky_visual') {
    return finish('fallback', 'sticky_visual');
  }

  if (!deps.host.isLaunched()) await deps.host.launch();
  const taskUrl = extractTaskUrl(task);
  if (taskUrl) {
    if (isBlockedSystemUrl(taskUrl)) return finish('needs_review', 'system_settings');
    if (!sameUrl(deps.host.currentUrl(), taskUrl)) await deps.host.navigate(taskUrl);
  }
  if (isBlockedSystemUrl(deps.host.currentUrl())) return finish('needs_review', 'system_settings');

  while (steps < BROWSER_JEV_HARD_STEP_LIMIT) {
    if (context.abortSignal?.aborted) {
      return finish('fallback', 'aborted');
    }
    if ((deps.now ?? Date.now)() - started >= BROWSER_JEV_TIME_LIMIT_MS) {
      return finish('time_limit', 'time_limit');
    }
    if (steps >= softStepLimit) {
      return finish('step_limit', 'step_limit');
    }
    if (isBlockedSystemUrl(deps.host.currentUrl())) {
      return finish('needs_review', 'system_settings');
    }

    const captured = carriedSnapshot ?? await deps.host.capture();
    carriedSnapshot = undefined;
    // 步后段已对同一 captured prepare 过一次（fingerprint 用），除 mutate 需重算外直接复用
    const prepared = carriedPrepared
      ?? prepareJevBrowserSnapshot(captured, task, {
        mutateEmptyWindow: mutate === 'empty-window',
      });
    carriedPrepared = undefined;
    const dialog = deps.host.getDialogState();
    if (dialog.pending) {
      return finish(
        'needs_review',
        'dialog_pending: hand back to main model handle_dialog approval gate',
        {
          code: 'SURFACE_APPROVAL_REQUIRED',
          userActionRequired: true,
          dialogType: dialog.type || 'unknown',
        },
      );
    }

    const visibleText = await deps.host.getVisibleText();
    const visible = [
      captured.snapshot.title,
      ...captured.snapshot.headings.map((heading) => heading.text),
      visibleText,
    ].join('\n');
    const takeover = classifyBrowserComputerManualTakeover(visible);
    if (takeover === 'captcha_or_risk_control' || takeover === 'mfa_required') {
      return finish('needs_review', takeover, { captchaClass: takeover });
    }
    if (takeover === 'manual_takeover_required' || MANUAL_TAKEOVER_COPY.test(visible)) {
      return finish('needs_review', 'manual_takeover_required', { captchaClass: 'manual_takeover_required' });
    }
    if (isJevLoginWall(captured, visibleText)) {
      return finish('needs_review', 'login_required', { captchaClass: 'login_required' });
    }

    if (prepared.sensitiveFieldsPresent && UPLOAD_TASK.test(task)) {
      return finish(
        'needs_review',
        '任务含上传/文件语义且页面含敏感字段（密码/文件），交回主模型走现行审批门',
        {
          code: 'SURFACE_APPROVAL_REQUIRED',
          userActionRequired: true,
        },
      );
    }

    const { formValuesError, ...evidence } = await evidenceFrom(deps.host, captured);
    if (formValuesError) {
      return finish('fallback', `form_values_unavailable: ${formValuesError}`);
    }
    const evaluated = evaluateJevAssertions(assertions, evidence);
    // Override and self-extracted share this gate: steps=0 (navigate-before-loop
    // does not count) cannot done_verified. Models must not pass a trivial
    // assertion like url_includes:'/' and skip the action.
    if (evaluated.allMet && steps > 0) {
      return finish('done_verified', undefined, { assertions: evaluated.results });
    }

    if (prepared.selected.length === 0) {
      turn.emptyWindowRounds += 1;
      if (turn.emptyWindowRounds === 1) {
        await deps.host.scroll('down');
        recentSteps.push({ op: 'scroll_down', target_name: '', result: 'micro_empty_window' });
        steps += 1;
        continue;
      }
      if (turn.emptyWindowRounds >= 2) turn.mode = 'sticky_visual';
      return finish('fallback', 'no_candidates');
    }
    turn.emptyWindowRounds = 0;

    if (prepared.sensitiveFieldsPresent && assertions.some((assertion) => /password|密码/i.test(assertion.needle))) {
      return finish('needs_review', 'password_field');
    }

    const guarded = guardJevBrowserSnapshot({
      task,
      prepared,
      assertions: evaluated.results,
      recentSteps,
    });
    if (guarded.blocked) {
      turn.mode = 'sticky_visual';
      return finish('fallback', 'sanitizer_blocked');
    }
    if (guarded.overBudget) {
      return finish('fallback', 'state_over_budget');
    }

    const questions = buildBrowserStepQuestions(guarded.labels);
    const stateChars = JSON.stringify(guarded.state).length;
    const questionChars = JSON.stringify(questions).length;
    const nextUsd = estimateJevCallUsd(stateChars, questionChars);
    if (spentUsd + nextUsd > budgetUsd) {
      turn.mode = 'sticky_visual';
      return finish('fallback', 'budget');
    }

    let answers: JevAnswers;
    try {
      answers = await deps.systemOne(guarded.state, questions, { signal: context.abortSignal });
      jevCalls += 1;
      jevChars += stateChars + questionChars;
      spentUsd += nextUsd;
    } catch {
      if (context.abortSignal?.aborted) return finish('fallback', 'aborted');
      turn.consecutiveJevFailures += 1;
      if (turn.consecutiveJevFailures >= 2) turn.mode = 'sticky_visual';
      return finish('fallback', 'jev_error');
    }

    const applied = applyJevAnswers({
      answers,
      windowIds: new Set(guarded.selected.map((candidate) => candidate.refId)),
      mutateDone1: mutate === 'done1',
    });
    if (!applied.ok && applied.reason === 'incompatible_target' && applied.retryAsk && !incompatibleRetryUsed) {
      incompatibleRetryUsed = true;
      continue;
    }
    if (!applied.ok) {
      turn.consecutiveJevFailures += 1;
      if (turn.consecutiveJevFailures >= 2) turn.mode = 'sticky_visual';
      return finish('fallback', applied.reason);
    }
    turn.consecutiveJevFailures = 0;

    if (applied.doneNoul >= BROWSER_STEP_THRESHOLDS.doneSignalLog) {
      falseDoneCount += 1;
    }

    if (prepared.window.truncated && applied.operation !== 'scroll_down' && applied.operation !== 'scroll_up') {
      truncatedWithoutScroll += 1;
      if (truncatedWithoutScroll >= 2) {
        await deps.host.scroll('down');
        recentSteps.push({ op: 'scroll_down', target_name: '', result: 'forced_truncated' });
        truncatedWithoutScroll = 0;
        steps += 1;
        continue;
      }
    } else {
      truncatedWithoutScroll = 0;
    }

    const target = applied.targetId
      ? guarded.selected.find((candidate) => candidate.refId === applied.targetId) ?? null
      : null;
    const targetName = target?.name || '';
    const riskHit = applied.riskNoul >= BROWSER_STEP_THRESHOLDS.riskUpgrade
      || RISK_KEYWORD.test(targetName)
      || RISK_KEYWORD.test(target?.text || '')
      || (guarded.injectionFlag && (applied.operation === 'click' || applied.operation === 'type'));
    // ponytail: 与基线同档：injection_flag 升级不覆盖 press_enter，是已知天花板
    if (riskHit && (applied.operation === 'click' || applied.operation === 'type' || applied.operation === 'press_enter')) {
      const approved = await context.requestPermission({
        type: 'dangerous_command',
        tool: 'Browser.execute_goal',
        forceConfirm: true,
        dangerLevel: 'danger',
        reason: '可能确认支付、删除或授权，必须对当前动作显式批准。',
        details: { action: applied.operation, target: targetName },
      });
      if (!approved) {
        return finish('needs_review', 'SURFACE_APPROVAL_REQUIRED', {
          code: 'SURFACE_APPROVAL_REQUIRED',
          userActionRequired: true,
        });
      }
    }

    let opResult = 'ok';
    let typedValue = '';
    try {
      if (applied.operation === 'click' && target) {
        await clickWithRebind(deps.host, target, prepared);
      } else if (applied.operation === 'type' && target) {
        const value = await generateTypeValue(task, target, deps.quickType);
        if (value == null) return finish('fallback', 'type_value_unavailable');
        typedValue = value;
        await typeWithRebind(deps.host, target, typedValue, prepared);
      } else if (applied.operation === 'scroll_down') {
        await deps.host.scroll('down');
      } else if (applied.operation === 'scroll_up') {
        await deps.host.scroll('up');
      } else if (applied.operation === 'press_enter') {
        await deps.host.pressEnter();
      } else if (applied.operation === 'wait') {
        await deps.host.wait(1000);
      } else if (applied.operation === 'stop') {
        opResult = 'stop_unverified';
      }
    } catch (error) {
      if (isStaleTargetRefError(error) && target) {
        const refreshed = prepareJevBrowserSnapshot(await deps.host.capture(), task, {
          mutateEmptyWindow: mutate === 'empty-window',
        });
        const rebound = rebindTarget(refreshed, target.targetRef);
        if (!rebound) return finish('fallback', 'stale_target');
        try {
          if (applied.operation === 'click') await deps.host.clickTargetRef(rebound);
          else if (applied.operation === 'type') {
            await deps.host.typeTargetRef(rebound, typedValue);
          }
        } catch {
          return finish('fallback', 'stale_target');
        }
      } else {
        opResult = error instanceof Error ? error.message : String(error);
      }
    }

    recentSteps.push({ op: applied.operation, target_name: targetName, result: opResult });
    steps += 1;

    // ponytail: click 弹 confirm 时步后 capture 会卡到 dialog 门，基线同场景一样卡，已知天花板
    const after = await deps.host.capture();
    carriedSnapshot = after;
    const { formValuesError: afterFormValuesError, ...afterEvidence } = await evidenceFrom(deps.host, after);
    if (afterFormValuesError) {
      return finish('fallback', `form_values_unavailable: ${afterFormValuesError}`);
    }
    // 完成优先于撞限：步后就地判一次断言。圈头的时限/软步顶检查先于断言评估，
    // 恰在上限那一步完成的任务要等下一圈才被评估，而下一圈第一件事就是撞限返回。
    // steps>0 与圈头门同形（此处 steps 必 ≥1，防止将来有人把这段挪回步前）。
    const afterEvaluated = evaluateJevAssertions(assertions, afterEvidence);
    if (afterEvaluated.allMet && steps > 0) {
      return finish('done_verified', undefined, { assertions: afterEvaluated.results });
    }
    const afterPrepared = prepareJevBrowserSnapshot(after, task);
    carriedPrepared = mutate === 'empty-window' ? undefined : afterPrepared;
    const inView = afterPrepared.collected
      .filter((candidate) => candidate.inView)
      .map((candidate) => `${candidate.name}+${candidate.role || ''}`);
    const fingerprint = pageFingerprint(afterEvidence, inView);
    if (fingerprint === lastFingerprint) consecutiveNoProgress += 1;
    else consecutiveNoProgress = 0;
    lastFingerprint = fingerprint;
    if (consecutiveNoProgress >= NO_PROGRESS_LIMIT) {
      return finish('stalled', 'stalled');
    }
  }

  return finish('step_limit', 'step_limit');
}

async function clickWithRebind(
  host: JevBrowserHost,
  target: JevCandidate,
  prepared: PreparedJevSnapshot,
): Promise<void> {
  try {
    await host.clickTargetRef(target.targetRef);
  } catch (error) {
    if (!isStaleTargetRefError(error)) throw error;
    const rebound = rebindTarget(prepared, target.targetRef);
    if (!rebound) throw error;
    await host.clickTargetRef(rebound);
  }
}

async function typeWithRebind(
  host: JevBrowserHost,
  target: JevCandidate,
  value: string,
  prepared: PreparedJevSnapshot,
): Promise<void> {
  try {
    await host.typeTargetRef(target.targetRef, value);
  } catch (error) {
    if (!isStaleTargetRefError(error)) throw error;
    const rebound = rebindTarget(prepared, target.targetRef);
    if (!rebound) throw error;
    await host.typeTargetRef(rebound, value);
  }
}

async function generateTypeValue(
  task: string,
  target: JevCandidate,
  quickType?: (prompt: string) => Promise<string | null>,
): Promise<string | null> {
  if (!quickType) {
    const quoted = task.match(/`([^`]{1,80})`/);
    return quoted ? quoted[1] : task.slice(0, 80);
  }
  const field = guardJevPromptText(target.name);
  const placeholder = target.placeholder ? guardJevPromptText(target.placeholder) : '';
  const prompt = [
    'Generate only the literal value to type into the field. No quotes, no explanation.',
    `Task: ${task.slice(0, 500)}`,
    `Field: ${field}`,
    placeholder ? `Placeholder: ${placeholder}` : '',
  ].filter(Boolean).join('\n');
  return quickType(prompt);
}

function resolveJevBrowserHost(
  extra: JevBrowserStepDriverDeps | undefined,
  input: JevBrowserStepRunInput,
): JevBrowserHost | undefined {
  if (extra?.host) return extra.host;
  const service = input.browserService ?? extra?.browserService;
  return service ? createManagedJevBrowserHost(service) : undefined;
}

function createJevBrowserStepDriver(call: JevSystemOneCall, extra?: JevBrowserStepDriverDeps): JevBrowserStepDriver {
  return {
    async run(input, context) {
      const host = resolveJevBrowserHost(extra, input);
      if (!host) return jevBrowserStepUnarmedResult();
      const { quickTask } = await import('../../../model/quickModel');
      const defaultQuickType = async (prompt: string) => {
        const generated = await quickTask(prompt, 64, context.abortSignal);
        return generated.success ? (generated.content || '').trim() || null : null;
      };
      const result = await runJevBrowserStepLoop(input, context, {
        systemOne: extra?.systemOne ?? call,
        host,
        mutate: extra?.mutate ?? input.mutate,
        quickType: extra && Object.hasOwn(extra, 'quickType')
          ? extra.quickType ?? undefined
          : defaultQuickType,
        now: extra?.now,
      });
      return toToolResult(result);
    },
  };
}

export function resolveBrowserJevStep(deps?: {
  systemOne?: JevSystemOneCall;
  onWarn?: (msg: string) => void;
  host?: JevBrowserHost;
  browserService?: BrowserService;
  mutate?: 'done1' | 'empty-window';
  quickType?: ((prompt: string) => Promise<string | null>) | null;
  now?: () => number;
}): JevBrowserStepDriver | undefined {
  if (!isBrowserJevStepEnabled()) return undefined;
  const quickTypeExtra = deps && Object.hasOwn(deps, 'quickType')
    ? { quickType: deps.quickType }
    : {};
  if (deps?.systemOne) {
    return createJevBrowserStepDriver(deps.systemOne, {
      systemOne: deps.systemOne,
      host: deps.host,
      browserService: deps.browserService,
      mutate: deps.mutate,
      ...quickTypeExtra,
      now: deps.now,
    });
  }
  const apiKey = resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL });
  if (!apiKey) {
    if (!missingKeyWarned) {
      console.warn(BROWSER_JEV_MISSING_KEY_WARN);
      missingKeyWarned = true;
    }
    deps?.onWarn?.(BROWSER_JEV_MISSING_KEY_WARN);
    return undefined;
  }
  const call: JevSystemOneCall = (state, questions, options) =>
    import('../../../model/providers/typesafeProvider').then((mod) => mod.systemOne(state, questions, options));
  return createJevBrowserStepDriver(call, {
    systemOne: call,
    host: deps?.host,
    browserService: deps?.browserService,
    mutate: deps?.mutate,
    ...quickTypeExtra,
    now: deps?.now,
  });
}

export function jevBrowserStepUnarmedResult(): ToolExecutionResult {
  return {
    success: false,
    error: 'Jev 步选未开启或未装配',
    metadata: { status: 'fallback', fallback: true, reason: 'unarmed', browserJevMode: 'unarmed' },
  };
}

export function jevBrowserStepEmptyTaskResult(): ToolExecutionResult {
  return {
    success: false,
    error: 'Jev browser step fallback: empty_task',
    metadata: { status: 'fallback', fallback: true, reason: 'empty_task' },
  };
}
