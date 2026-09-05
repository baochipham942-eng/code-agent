// ============================================================================
// 上线后打分编排（ADR-063 刀 1 · N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// 取近 N 天会话 → 按 session_type 剔分母 → 每轮算确定性信号 → 决定全评/抽样/只记信号
// → 调无题 judge → 一行理由过脱敏 → 写 telemetry_turn_scores。
//
// 全部外部依赖走 deps 注入（db / 回放 / LLM / 磁盘存在性 / 时钟），单测一个都不碰真机：
// 不读写真实 ~/.code-agent，不调真模型。
// ============================================================================
import type BetterSqlite3 from 'better-sqlite3';
import type { ReplayBlock, ReplayTurn, StructuredReplay } from '../../../shared/contract/evaluationReplay';
import {
  POST_LAUNCH_DEFAULTS,
  POST_LAUNCH_JUDGE_VERSION,
  DRY_RUN_JUDGE_VERSION,
  POST_LAUNCH_RUBRIC_VERSION,
  isPostLaunchScorableSessionType,
  type DeterministicSignal,
  type PostLaunchDims,
  type PostLaunchScoringRequest,
  type PostLaunchScoringResult,
  type PostLaunchTurnScore,
} from '../../../shared/contract/postLaunchScore';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';
import { classifyFailure, type FailureCodebook } from '../failureCodes';
import { judgePostLaunchTurn, type PostLaunchJudgeLlmCall } from '../judge/postLaunchJudge';
import { computeTurnSignals } from './postLaunchSignals';
import { getBudgetState, getScoredTurnIds, insertTurnScore, localDay,
  acquireScoringLock,
  releaseScoringLock,
} from './postLaunchScoreStore';

/** 触发安全维判负的信号。 */
const SAFETY_BREACH_SIGNALS = new Set<DeterministicSignal['kind']>(['out_of_workspace_write', 'approval_bypassed']);
/** 触发产物维判负的信号。 */
const ARTIFACT_BREACH_SIGNALS = new Set<DeterministicSignal['kind']>(['claimed_file_missing']);

/** 没有对应失败码的信号，映射成码本自己的正则认得的说法，避免另造码表。 */
const SIGNAL_FAILURE_HINT: Partial<Record<DeterministicSignal['kind'], string>> = {
  claimed_file_missing: 'missing artifact file not found',
  repeat_loop: '重复循环',
  timeout: '超时',
};

export interface PostLaunchSessionRow {
  id: string;
  sessionType: string | null;
  workingDirectory: string | null;
  modelProvider: string;
  modelName: string;
  agentVersion: string | null;
  promptVersion: string | null;
}

export interface PostLaunchScorerDeps {
  db: BetterSqlite3.Database;
  getStructuredReplay: (sessionId: string) => Promise<StructuredReplay | null>;
  llmCall: PostLaunchJudgeLlmCall;
  /** judge 这一次调用的刊例估算成本（USD）。 */
  estimateJudgeCostUsd: (prompt: string, completion: string) => number;
  /** 一轮 agent 侧的刊例估算成本（USD），用于 cost_anomaly 信号。 */
  estimateTurnCostUsd: (session: PostLaunchSessionRow, inputTokens: number, outputTokens: number) => number;
  fileExists: (absolutePath: string) => boolean;
  now: () => number;
  failureCodebook: FailureCodebook;
  onWarn?: (message: string, error?: unknown) => void;
}

interface TurnRow {
  id: string;
  turn_number: number;
  start_time: number;
  turn_type: string;
  parent_turn_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
}

interface ScorableTurn {
  turnId: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  blocks: ReplayBlock[];
  /** 供 judge 读的合成轮（含子迭代的块）。 */
  turn: ReplayTurn;
}

function listSessions(db: BetterSqlite3.Database, since: number): PostLaunchSessionRow[] {
  const rows = db
    .prepare(`
      SELECT id, session_type, working_directory, model_provider, model_name, agent_version, prompt_version
      FROM telemetry_sessions
      WHERE start_time >= ?
      ORDER BY start_time DESC
    `)
    .all(since) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    sessionType: (row.session_type as string | null) ?? null,
    workingDirectory: (row.working_directory as string | null) ?? null,
    modelProvider: (row.model_provider as string) ?? 'unknown',
    modelName: (row.model_name as string) ?? 'unknown',
    agentVersion: (row.agent_version as string | null) ?? null,
    promptVersion: (row.prompt_version as string | null) ?? null,
  }));
}

/**
 * 把回放的轮映射回 telemetry_turns 的行，并把 iteration 轮的块并进它的 user 父轮。
 * 分母是「用户会话的轮」，agentic loop 的每一步不单独计一轮。
 * 匹配键用 (turn_number, start_time)：回放会按 rewound 区间过滤掉一部分行，按下标对不齐。
 */
function collectScorableTurns(replay: StructuredReplay, turnRows: TurnRow[]): ScorableTurn[] {
  const byKey = new Map(turnRows.map((row) => [`${row.turn_number}:${row.start_time}`, row]));
  const byId = new Map(turnRows.map((row) => [row.id, row]));
  const owners = new Map<string, ScorableTurn>();

  for (const replayTurn of replay.turns) {
    const row = byKey.get(`${replayTurn.turnNumber}:${replayTurn.startTime}`);
    if (!row) continue;
    const ownerRow = row.turn_type === 'iteration' && row.parent_turn_id
      ? byId.get(row.parent_turn_id) ?? row
      : row;
    let owner = owners.get(ownerRow.id);
    if (!owner) {
      owner = {
        turnId: ownerRow.id,
        startedAt: ownerRow.start_time,
        inputTokens: 0,
        outputTokens: 0,
        blocks: [],
        turn: { ...replayTurn, blocks: [] },
      };
      owners.set(ownerRow.id, owner);
    }
    owner.blocks.push(...replayTurn.blocks);
    owner.inputTokens += replayTurn.inputTokens;
    owner.outputTokens += replayTurn.outputTokens;
  }

  for (const owner of owners.values()) {
    owner.blocks.sort((left, right) => left.timestamp - right.timestamp);
    owner.turn = { ...owner.turn, blocks: owner.blocks };
  }
  return [...owners.values()].sort((left, right) => right.startedAt - left.startedAt);
}

/**
 * 一行理由过脱敏闸：命中即置空并标 redacted（ADR-063 §1）。
 * 不做「脱敏后照发」——理由是给人看的一句话，掩码后的残句既没信息又让人以为看到了全部。
 */
function redactReason(reason: string): { text: string; redacted: boolean } {
  const trimmed = reason.trim().slice(0, POST_LAUNCH_DEFAULTS.reasonMaxChars);
  if (!trimmed) return { text: '', redacted: false };
  const guarded = guardSensitiveText(trimmed, {
    surface: 'export',
    mode: 'share',
    maxLength: trimmed.length + 1,
  });
  return guarded === trimmed ? { text: trimmed, redacted: false } : { text: '', redacted: true };
}

/** 安全 / 产物两维由信号直接映射，不问模型。 */
function mapDeterministicDims(signals: DeterministicSignal[]): Pick<PostLaunchDims, 'safety' | 'artifact'> {
  return {
    safety: signals.some((signal) => SAFETY_BREACH_SIGNALS.has(signal.kind)) ? 0 : 1,
    artifact: signals.some((signal) => ARTIFACT_BREACH_SIGNALS.has(signal.kind)) ? 0 : 1,
  };
}

/** failure_class 复用 N-EVAL-FAILCODE 的七码优先级栈，不另造码表。 */
function deriveFailureClass(
  signals: DeterministicSignal[],
  errorTexts: string[],
  codebook: FailureCodebook,
  anyDimFailed: boolean,
): string | null {
  if (signals.length === 0 && !anyDimFailed) return null;
  const hints = signals.map((signal) => SIGNAL_FAILURE_HINT[signal.kind]).filter(Boolean) as string[];
  const failureReason = [...errorTexts, ...hints].join('\n');
  return classifyFailure({ failureReason }, codebook).primaryFailureCode;
}

export async function runPostLaunchScoring(
  deps: PostLaunchScorerDeps,
  request: PostLaunchScoringRequest = {},
): Promise<PostLaunchScoringResult> {
  const now = deps.now();
  const days = request.days ?? POST_LAUNCH_DEFAULTS.days;
  const budgetLimitUsd = request.dailyBudgetUsd ?? POST_LAUNCH_DEFAULTS.dailyBudgetUsd;
  const sampleLimit = request.dailySampleLimit ?? POST_LAUNCH_DEFAULTS.dailySampleLimit;
  const dryRun = request.dryRun === true;
  const day = localDay(now);
  const since = now - days * 24 * 60 * 60 * 1000;

  const budget = getBudgetState(deps.db, day, { limitUsd: budgetLimitUsd, sampleLimit });
  let spentUsd = budget.spentUsd;
  let sampledToday = budget.sampledCount;

  const result: PostLaunchScoringResult = {
    examinedTurns: 0,
    excludedTurns: 0,
    signalTurns: 0,
    sampledTurns: 0,
    signalOnlyTurns: 0,
    skippedTurns: 0,
    costUsd: 0,
    budgetStopped: false,
    locked: false,
    dryRun,
  };

  const lockOwner = `${process.pid}:${now}`;
  if (!acquireScoringLock(deps.db, lockOwner, now)) {
    result.locked = true;
    return result;
  }
  try {
    await scoreSessions();
  } finally {
    releaseScoringLock(deps.db, lockOwner);
  }
  return result;

  async function scoreSessions(): Promise<void> {
  for (const session of listSessions(deps.db, since)) {
    const turnRows = deps.db
      .prepare(`
        SELECT id, turn_number, start_time, turn_type, parent_turn_id, total_input_tokens, total_output_tokens
        FROM telemetry_turns WHERE session_id = ?
      `)
      .all(session.id) as TurnRow[];
    if (turnRows.length === 0) continue;

    if (!isPostLaunchScorableSessionType(session.sessionType)) {
      // 剔出分母的轮只计数，一行分数都不落——它们不是真实用户会话。
      result.examinedTurns += turnRows.length;
      result.excludedTurns += turnRows.filter((row) => row.turn_type !== 'iteration').length;
      continue;
    }

    let replay: StructuredReplay | null;
    try {
      replay = await deps.getStructuredReplay(session.id);
    } catch (error) {
      deps.onWarn?.(`会话 ${session.id} 回放失败，跳过`, error);
      continue;
    }
    if (!replay) continue;

    const scorable = collectScorableTurns(replay, turnRows);
    result.examinedTurns += scorable.length;
    // dry-run 的行记成 'dry-run' 版本：既不挡之后的真评，真评的行也会按 turn_id 主键覆盖它
    // dry-run 遇到任何已有行（含真评）都跳过：表按 turn_id 主键 INSERT OR REPLACE，否则会把真评覆盖成 null（ai-review #1645）
    const alreadyScored = getScoredTurnIds(deps.db, scorable.map((turn) => turn.turnId), dryRun ? [DRY_RUN_JUDGE_VERSION, POST_LAUNCH_JUDGE_VERSION] : [POST_LAUNCH_JUDGE_VERSION]);

    for (const turn of scorable) {
      if (alreadyScored.has(turn.turnId)) {
        result.skippedTurns += 1;
        continue;
      }

      const turnCostUsd = deps.estimateTurnCostUsd(session, turn.inputTokens, turn.outputTokens);
      const signals = computeTurnSignals(turn.turn, turn.turnId, {
        workspaceDir: session.workingDirectory ?? undefined,
        turnCostUsd,
        fileExists: deps.fileExists,
      });

      const hasSignal = signals.length > 0;
      const budgetLeft = spentUsd < budgetLimitUsd;
      const sampleLeft = sampledToday < sampleLimit;
      // 信号命中的轮全评；其余按日抽样。预算用完当天停评，只记信号。
      const shouldJudge = !dryRun && budgetLeft && (hasSignal || sampleLeft);
      if (!dryRun && !budgetLeft) result.budgetStopped = true;

      const deterministic = mapDeterministicDims(signals);
      let dims: PostLaunchDims = {
        goal: null,
        orchestration: null,
        tools: null,
        permission: null,
        ...deterministic,
      };
      let reasoning = hasSignal ? signals.map((signal) => signal.detail ?? signal.kind).join('；') : '';
      let judgeModel = 'unavailable';
      let promptHash = '';
      let judgeVersion = dryRun ? DRY_RUN_JUDGE_VERSION : POST_LAUNCH_JUDGE_VERSION;
      let rubricVersion = POST_LAUNCH_RUBRIC_VERSION;
      let judgeCostUsd = 0;

      if (shouldJudge) {
        let judgePrompt = '';
        let judgeCompletion = '';
        const verdict = await judgePostLaunchTurn({ turn: turn.turn, signals }, async (prompt) => {
          judgePrompt = prompt;
          const response = await deps.llmCall(prompt);
          judgeCompletion = typeof response === 'string' ? response : response.content;
          return response;
        });
        dims = { ...dims, ...verdict.dims };
        reasoning = verdict.reasoning || reasoning;
        judgeModel = verdict.judgeModel;
        promptHash = verdict.promptHash;
        judgeVersion = verdict.judgeVersion;
        rubricVersion = verdict.rubricVersion;
        judgeCostUsd = deps.estimateJudgeCostUsd(judgePrompt, judgeCompletion);
        spentUsd += judgeCostUsd;
        result.costUsd += judgeCostUsd;
        if (hasSignal) result.signalTurns += 1;
        else {
          result.sampledTurns += 1;
          sampledToday += 1;
        }
      } else {
        result.signalOnlyTurns += 1;
      }

      const errorTexts = turn.blocks.filter((block) => block.type === 'error').map((block) => block.content);
      const anyDimFailed = Object.values(dims).some((value) => value === 0);
      const reason = redactReason(reasoning);
      const score: PostLaunchTurnScore = {
        sessionId: session.id,
        turnId: turn.turnId,
        scoredAt: now,
        scoredDay: day,
        appVersion: session.agentVersion,
        promptVersion: session.promptVersion,
        judgeVersion,
        rubricVersion,
        judgeModel,
        promptHash,
        dims,
        failureClass: deriveFailureClass(signals, errorTexts, deps.failureCodebook, anyDimFailed),
        reasonRedacted: reason.text,
        redacted: reason.redacted,
        signals: signals.map((signal) => signal.kind),
        costUsd: judgeCostUsd,
        sampledBy: hasSignal ? 'signal' : 'sample',
      };
      insertTurnScore(deps.db, score, turn.startedAt);
    }
  }
  }
}
