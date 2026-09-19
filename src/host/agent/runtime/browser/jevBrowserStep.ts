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
  type BrowserStepOperation,
  type JevAnswers,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevSystemOneCall,
} from '../../../../shared/constants/jevQuestions';
import { resolveProviderApiKey } from '../../../model/providers/providerResolution';
import { classifyBrowserComputerManualTakeover } from '../../../../shared/utils/browserComputerRedaction';
import type { BrowserService } from '../../../services/infra/browserService';
import { guardJevBrowserSnapshot } from '../../../services/infra/browser/jevBrowserSnapshotGuard';
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
  task: string;
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
  quickType?: (prompt: string) => Promise<string | null>;
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

function isBrowserJevStepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_BROWSER_JEV_STEP === '1';
}

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
  if (!(operation.choice in BROWSER_STEP_OPERATIONS)) {
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

function extractTaskUrl(task: string): string | null {
  const match = task.match(TASK_URL_RE);
  return match ? match[0] : null;
}

function sameUrl(current: string, target: string): boolean {
  try {
    const left = new URL(current);
    const right = new URL(target);
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch {
    return current === target;
  }
}

function rebindTarget(prepared: PreparedJevSnapshot, previous: BrowserTargetRef): BrowserTargetRef | null {
  const match = prepared.collected.find((candidate) => (
    candidate.targetRef.name === previous.name
    && (candidate.role || null) === (previous.role || null)
    && candidate.tag.toLowerCase() === (previous.selector?.split(/[#.[]/)[0] || candidate.tag).toLowerCase()
  )) || prepared.collected.find((candidate) => (
    candidate.targetRef.name === previous.name && (candidate.role || null) === (previous.role || null)
  ));
  return match?.targetRef ?? null;
}

async function evidenceFrom(host: JevBrowserHost, captured: JevCapturedSnapshot) {
  const formValues = await host.getFormValues();
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
  };
}

function toToolResult(result: JevBrowserStepResult): ToolExecutionResult {
  const success = result.status === 'done_verified' || result.status === 'fallback';
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
  const assertions = extractJevAssertions(input.task, input.assertions);
  const mutate = deps.mutate ?? input.mutate;
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

  if (turn.mode === 'sticky_visual') {
    return finish('fallback', 'sticky_visual');
  }

  if (!deps.host.isLaunched()) await deps.host.launch();
  const taskUrl = extractTaskUrl(input.task);
  if (taskUrl) {
    if (isBlockedSystemUrl(taskUrl)) return finish('needs_review', 'system_settings');
    if (!sameUrl(deps.host.currentUrl(), taskUrl)) await deps.host.navigate(taskUrl);
  }
  if (isBlockedSystemUrl(deps.host.currentUrl())) return finish('needs_review', 'system_settings');

  while (steps < BROWSER_JEV_HARD_STEP_LIMIT) {
    if ((deps.now ?? Date.now)() - started >= BROWSER_JEV_TIME_LIMIT_MS) {
      return finish('time_limit', 'time_limit');
    }
    if (steps >= BROWSER_JEV_SOFT_STEP_LIMIT) {
      return finish('step_limit', 'step_limit');
    }

    const captured = await deps.host.capture();
    const prepared = prepareJevBrowserSnapshot(captured, input.task, {
      mutateEmptyWindow: mutate === 'empty-window',
    });
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

    const visible = [
      captured.snapshot.title,
      ...captured.snapshot.headings.map((heading) => heading.text),
      await deps.host.getVisibleText(),
    ].join('\n');
    const takeover = classifyBrowserComputerManualTakeover(visible);
    if (takeover === 'captcha_or_risk_control' || takeover === 'mfa_required' || takeover === 'login_required') {
      return finish('needs_review', takeover, { captchaClass: takeover });
    }

    if (prepared.sensitiveFieldsPresent && UPLOAD_TASK.test(input.task)) {
      return finish(
        'needs_review',
        'upload: hand back to main model upload_file approval gate',
        {
          code: 'SURFACE_APPROVAL_REQUIRED',
          userActionRequired: true,
        },
      );
    }

    const evidence = await evidenceFrom(deps.host, captured);
    const evaluated = evaluateJevAssertions(assertions, evidence);
    if (evaluated.allMet) {
      return finish('done_verified', undefined, { assertions: evaluated.results });
    }

    if (prepared.selected.length === 0) {
      turn.emptyWindowRounds += 1;
      if (turn.emptyWindowRounds === 1) {
        await deps.host.scroll('down');
        recentSteps.push({ op: 'scroll_down', target_name: '', result: 'micro_empty_window' });
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
      task: input.task,
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
      answers = await deps.systemOne(guarded.state, questions);
      jevCalls += 1;
      jevChars += stateChars + questionChars;
      spentUsd += nextUsd;
    } catch {
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

    if (applied.doneNoul >= BROWSER_STEP_THRESHOLDS.doneSignalLog && !evaluated.allMet) {
      falseDoneCount += 1;
    }

    if (prepared.window.truncated && applied.operation !== 'scroll_down' && applied.operation !== 'scroll_up') {
      truncatedWithoutScroll += 1;
      if (truncatedWithoutScroll >= 2 && !evaluated.allMet) {
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
    try {
      if (applied.operation === 'click' && target) {
        await clickWithRebind(deps.host, target, prepared);
      } else if (applied.operation === 'type' && target) {
        const value = await generateTypeValue(input.task, target, deps.quickType);
        if (value == null) return finish('fallback', 'type_value_unavailable');
        await typeWithRebind(deps.host, target, value, prepared);
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
        const refreshed = prepareJevBrowserSnapshot(await deps.host.capture(), input.task, {
          mutateEmptyWindow: mutate === 'empty-window',
        });
        const rebound = rebindTarget(refreshed, target.targetRef);
        if (!rebound) return finish('fallback', 'stale_target');
        try {
          if (applied.operation === 'click') await deps.host.clickTargetRef(rebound);
          else if (applied.operation === 'type') {
            const value = await generateTypeValue(input.task, target, deps.quickType);
            if (value == null) return finish('fallback', 'type_value_unavailable');
            await deps.host.typeTargetRef(rebound, value);
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

    const after = await deps.host.capture();
    const afterEvidence = await evidenceFrom(deps.host, after);
    const inView = prepareJevBrowserSnapshot(after, input.task).collected
      .filter((candidate) => candidate.inView)
      .map((candidate) => `${candidate.name}+${candidate.role || ''}`);
    const fingerprint = pageFingerprint(afterEvidence, inView);
    if (fingerprint === lastFingerprint) consecutiveNoProgress += 1;
    else consecutiveNoProgress = 0;
    lastFingerprint = fingerprint;
    if (consecutiveNoProgress >= NO_PROGRESS_LIMIT) {
      return finish('stalled', 'stalled', { false_done_count: falseDoneCount });
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
    const quoted = task.match(/`([^`]{1,80})`/) || task.match(/bench@[^\s]+/i);
    return quoted ? quoted[1] || quoted[0] : task.slice(0, 80);
  }
  const prompt = [
    'Generate only the literal value to type into the field. No quotes, no explanation.',
    `Task: ${task.slice(0, 500)}`,
    `Field: ${target.name}`,
    target.placeholder ? `Placeholder: ${target.placeholder}` : '',
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
      const result = await runJevBrowserStepLoop(input, context, {
        systemOne: extra?.systemOne ?? call,
        host,
        mutate: extra?.mutate ?? input.mutate,
        quickType: extra?.quickType ?? (async (prompt) => {
          const generated = await quickTask(prompt, 64, context.abortSignal);
          return generated.success ? (generated.content || '').trim() || null : null;
        }),
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
  quickType?: (prompt: string) => Promise<string | null>;
  now?: () => number;
}): JevBrowserStepDriver | undefined {
  if (!isBrowserJevStepEnabled()) return undefined;
  if (deps?.systemOne) {
    return createJevBrowserStepDriver(deps.systemOne, {
      systemOne: deps.systemOne,
      host: deps.host,
      browserService: deps.browserService,
      mutate: deps.mutate,
      quickType: deps.quickType,
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
    quickType: deps?.quickType,
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
