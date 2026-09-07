// ============================================================================
// 上线后评分契约（ADR-063 刀 1 · N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// 与发布前 judge（judgeDimensions / AiReviewDimension）**分开**：那套要 TestCase +
// expectations 才出判决，线上会话没有题、没有参考解。这里评的是过程质量。
// 正文不上 Neo 云端：本契约里只有分数、维度、失败类别、一行脱敏理由和信号名（judge 调用本身走用户配置的模型，投影先过脱敏闸）。
// ============================================================================
import type { SessionType } from './session';

/** 六维定名（爸 2026-09-05 拍板，对上 Neo 六条产品线）。 */
export const POST_LAUNCH_DIMENSIONS = [
  'goal',
  'orchestration',
  'tools',
  'permission',
  'safety',
  'artifact',
] as const;
export type PostLaunchDimension = (typeof POST_LAUNCH_DIMENSIONS)[number];

/**
 * judge 只回答需要读语义的四维；safety / artifact 由确定性信号直接映射，不问模型
 * （ADR-063 §2「安全与产物以代码判为主」）。
 */
export const POST_LAUNCH_JUDGE_DIMENSIONS = ['goal', 'orchestration', 'tools', 'permission'] as const;
export type PostLaunchJudgeDimension = (typeof POST_LAUNCH_JUDGE_DIMENSIONS)[number];

/** 0=不通过 1=通过 null=无判决（judge 不可用、或该维度证据不足）。null 不计入分母。 */
export type PostLaunchDimScore = 0 | 1 | null;
export type PostLaunchDims = Record<PostLaunchDimension, PostLaunchDimScore>;

/**
 * 九类确定性信号：代码能判的一律不进 LLM。
 * 命名与检测词表见 postLaunchSignals.ts，改任一类都要同步那里的真阳/真阴单测。
 */
export type PostLaunchSignalKind =
  | 'error_terminated'
  | 'user_cancelled'
  | 'approval_denied'
  | 'approval_bypassed'
  | 'timeout'
  | 'cost_anomaly'
  | 'repeat_loop'
  | 'claimed_file_missing'
  | 'out_of_workspace_write';

export interface DeterministicSignal {
  kind: PostLaunchSignalKind;
  turnId: string;
  /** 给人看的一行定位（已在采集处截断，不含工具入参出参原文）。 */
  detail?: string;
}

/**
 * 不进上线后分母的会话类型（ADR-063 §3）。
 * 判据用 session_type，不用早已作废的 CODE_AGENT_EVAL_BRIDGE 之类环境变量名。
 */
const POST_LAUNCH_EXCLUDED_SESSION_TYPES: readonly SessionType[] = [
  'eval',
  'subagent',
  'schedule',
  'heartbeat',
];

/** session_type 为空按 chat 处理（历史行没写这一列，它们确实是真实用户会话）。 */
function isScorableSessionType(sessionType: string | null | undefined): boolean {
  if (!sessionType) return true;
  return !POST_LAUNCH_EXCLUDED_SESSION_TYPES.includes(sessionType as SessionType);
}

/**
 * 存量行（K2 之前建的会话）没有 origin_kind，靠 CLI 自己的 id 前缀兜底剔。
 * 这是过渡判据：标记落地后新会话一律走 origin_kind，本前缀只管旧数据。
 */
const LEGACY_HEADLESS_ID_PREFIX = 'cli_session_';

export interface PostLaunchSessionDenominatorInput {
  id: string;
  sessionType: string | null | undefined;
  originKind: string | null | undefined;
}

/**
 * 进不进上线后分母。一处判、两处用（打分器与 CLI 报告），别在别处再写一份口径。
 * 剔两类：① session_type ∈ {eval, subagent, schedule, heartbeat}；
 * ② 脚本/无头发起的会话（neo CLI、评测真跑桥）——它们 session_type 也是 'chat'，
 *    从 session_type 一个字都看不出来（ADR-063 §3 + K1 留给刀 2 第 1 条）。
 */
export function isPostLaunchScorableSession(session: PostLaunchSessionDenominatorInput): boolean {
  if (!isScorableSessionType(session.sessionType)) return false;
  if (session.originKind) return session.originKind !== 'headless';
  return !session.id.startsWith(LEGACY_HEADLESS_ID_PREFIX);
}

/** judge 提示词或维度定义变了就要 +1；不同版本的分数不可相比（ADR-063 §2）。 */
export const POST_LAUNCH_JUDGE_VERSION = 'postlaunch-judge-v1';
/** dry-run 落表用的版本号：真评按 POST_LAUNCH_JUDGE_VERSION 查跳过时看不到它 */
export const DRY_RUN_JUDGE_VERSION = 'dry-run';
/** judge_model 哨兵：叫了打分模型但它没给出判决（没配好 / 报错 / 返回解析不了）。 */
export const JUDGE_MODEL_UNAVAILABLE = 'unavailable';
/**
 * judge_model 哨兵：这一轮压根没叫打分模型（dry-run / 预算停 / 抽样额度用完）。
 * K1 把两种情况都写成 'unavailable'，于是 09-05 真机截图把「抽样额度用完」误读成
 * 「打分模型没配好」——两个原因必须分得开，否则提示会指错方向。
 */
export const JUDGE_MODEL_NOT_JUDGED = 'not-judged';
/** 六维口径版本；与 judge 版本分开，改评分口径而不改提示词时只动这个。 */
export const POST_LAUNCH_RUBRIC_VERSION = 'postlaunch-rubric-v1';

/**
 * 开关三态：'on' / 'off' 是用户显式选择，'auto' = 跟随槽默认
 * （内部 dogfood 槽开、外部关，ADR-063 §3）。
 *
 * 「跟随默认」必须是一个**能跨 IPC 传输的值**，不能用 undefined：
 * JSON 序列化会整个丢掉 undefined 的键，宿主 `ConfigService.mergeSettings` 也明确
 * 跳过 undefined 保留旧值（`configService.ts:1236`）——那样「开 → 跟随默认」会静默失败，
 * 界面显示默认关、实际还在外发会话花额度（ai-review PR #1650 Important①）。
 * 老配置里没有这个键时按 'auto' 处理。
 */
export type PostLaunchScoringSwitch = 'on' | 'off' | 'auto';

/** 回流闸的本地会话级同意档（ADR-040）。默认 metadata；草稿至少需要 turn_excerpt。 */
export type PostLaunchConsentScope = 'metadata' | 'turn_excerpt' | 'full_session';

export const POST_LAUNCH_CONSENT_SCOPES: readonly PostLaunchConsentScope[] = [
  'metadata',
  'turn_excerpt',
  'full_session',
] as const;

/** 回流入口独立于评分开关：三态形状与评分一致，默认关闭（auto 仅内部槽开启）。 */
export type PostLaunchReflowSwitch = 'on' | 'off' | 'auto';

export function resolvePostLaunchReflowEnabled(
  setting: PostLaunchReflowSwitch | undefined,
  internalSlot: boolean,
): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return internalSlot;
}

export const POST_LAUNCH_REFLOW_DISABLED_MESSAGE
  = '上线后坏案例回流没开。去「设置 → 隐私防线」页的「数据共享」里把「坏案例回流」选成「开」再来。';

export function resolvePostLaunchScoringEnabled(
  setting: PostLaunchScoringSwitch | undefined,
  internalSlot: boolean,
): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return internalSlot;
}

/** 关着的时候 IPC 与 CLI 都拒评，给的是人话与开法，不是错误码。 */
export const POST_LAUNCH_DISABLED_MESSAGE
  = '上线后评分没开。它会把会话正文发给你自己配置的评分模型、花你自己的额度，所以默认不开；去「设置 → 隐私防线」页的「数据共享」里把「上线后质量评分」选成「开」再来。';

export const POST_LAUNCH_DEFAULTS = {
  /** 默认回看天数。 */
  days: 7,
  /** 日成本上限（USD，按 judge 模型刊例估算）。超限当天停评，只记信号。 */
  dailyBudgetUsd: 0.5,
  /** 未命中信号的轮，每天最多抽样评这么多。 */
  dailySampleLimit: 20,
  /** 单轮成本超过此值算 cost_anomaly（USD，刊例估算非账单）。 */
  costAnomalyUsd: 0.2,
  /** 同工具同参数连续调用达到这个次数算 repeat_loop。 */
  repeatLoopThreshold: 3,
  /** 一行理由的字数上限。 */
  reasonMaxChars: 200,
} as const;

export interface PostLaunchTurnScore {
  sessionId: string;
  turnId: string;
  scoredAt: number;
  /** 本地日历日 YYYY-MM-DD，日预算与日抽样都按它切。 */
  scoredDay: string;
  appVersion: string | null;
  promptVersion: string | null;
  judgeVersion: string;
  rubricVersion: string;
  judgeModel: string;
  promptHash: string;
  dims: PostLaunchDims;
  failureClass: string | null;
  /** ≤200 字，已过 guardSensitiveText；命中脱敏则为空串且 redacted=true。 */
  reasonRedacted: string;
  redacted: boolean;
  signals: PostLaunchSignalKind[];
  /** 刊例估算成本；模型没有公开刊例时是 0——展示与落库都不用兜底价（resolveModelPrice §2）。 */
  costUsd: number;
  /**
   * 记进日预算的那笔钱。有刊例时 = costUsd；没刊例时是按保守默认价的估算，
   * 让预算门对未知价模型也能触发（K1 时 costUsd 恒 0 ⇒ 预算门永远不响）。
   */
  budgetCostUsd: number;
  sampledBy: 'signal' | 'sample';
}

export interface PostLaunchDimRate {
  /** 有判决（非 null）的轮数——分母。 */
  judged: number;
  /** 判决为通过的轮数。 */
  passed: number;
}

/** 信号轮 / 抽样轮两行，不合并（ADR-063 §「风险」：信号轮全评会让问题轮过采）。 */
export interface PostLaunchScopeRow {
  scope: 'signal' | 'sample';
  turns: number;
  dims: Record<PostLaunchDimension, PostLaunchDimRate>;
}

/**
 * 下钻用的一条会话。**必须带名字**：只给 id 的话卡上一排芯片全长一个样——
 * CLI 会话前 8 位都是 `cli_sess`，App 会话是 8 位随机 hex，用户认不出点哪条
 * （09-05 真机截图 shot-4 实付）。
 */
export interface PostLaunchReportSession {
  id: string;
  /**
   * 会话标题。落 telemetry_sessions 时已过 guardTelemetryText（内含 guardSensitiveText），
   * 读出来不再脱敏一遍——重复脱敏只会把已掩码的串再啃一次。
   * 会话被删（LEFT JOIN 落空）或旧行没标题时是空串，展示侧回落 id 前缀。
   */
  title: string;
  /** telemetry_sessions.start_time；会话被删时是 0。 */
  startedAt: number;
}

/** 候选只带结构化分数/信号，不携带会话正文。 */
export interface PostLaunchReflowCandidate {
  sessionId: string;
  turnId: string | null;
  judgeVersion: string | null;
  redDimensions: PostLaunchDimension[];
  signals: PostLaunchSignalKind[];
  failureClass: string | null;
  /** 三路来源的稳定标签：judge 红、确定性信号、点踩。 */
  sources: Array<'judge' | 'signal' | 'feedback'>;
  feedbackId?: string;
  feedbackAt?: number;
  /** 统一排序键：评分行用 scored_at，点踩行用 created_at。 */
  occurredAt?: number;
}

export interface PostLaunchReportGroup {
  /** 该组所在自然周的周一，YYYY-MM-DD。 */
  weekStart: string;
  appVersion: string;
  promptVersion: string | null;
  rows: PostLaunchScopeRow[];
  failureClasses: Array<{ code: string; count: number }>;
  signals: Array<{ kind: PostLaunchSignalKind; count: number }>;
  costUsd: number;
  /** 下钻用：该组涉及的会话（点芯片 → 现有会话回放）。 */
  sessions: PostLaunchReportSession[];
}

type PostLaunchCalibrationReason = 'no_record' | 'below_threshold' | 'judge_changed';

export interface PostLaunchReport {
  generatedAt: number;
  days: number;
  judgeVersion: string;
  rubricVersion: string;
  /** 进分母的轮数（已剔 eval/subagent/schedule/heartbeat）。 */
  scoredTurns: number;
  groups: PostLaunchReportGroup[];
  /** 窗口内「叫了打分模型但它没给出判决」的轮数；> 0 时卡片与 CLI 都要出一行人话。 */
  judgeUnavailableTurns: number;
  /** κ 缺失或未达标时报告顶部挂「校准不足」（ADR-063 §「风险」）。 */
  calibration: { state: 'calibrated' | 'insufficient'; reason?: PostLaunchCalibrationReason };
  budget: PostLaunchBudgetState;
}

export interface PostLaunchBudgetState {
  day: string;
  spentUsd: number;
  limitUsd: number;
  sampledCount: number;
  sampleLimit: number;
  /** spentUsd 里按保守默认价估出来的部分（这些模型没有公开刊例）。 */
  assumedUsd: number;
  /** 今日已停评（只记信号不调模型）。 */
  stopped: boolean;
}

export interface PostLaunchScoringRequest {
  days?: number;
  dailyBudgetUsd?: number;
  dailySampleLimit?: number;
  /** 只算信号不调模型，用于 CLI --dry-run 与预算超限后的降级路径。 */
  dryRun?: boolean;
}

export interface PostLaunchScoringResult {
  /** 扫到的轮（含被剔除的）。 */
  examinedTurns: number;
  /** 因 session_type 被剔出分母的轮。 */
  excludedTurns: number;
  /** 命中信号、全评的轮。 */
  signalTurns: number;
  /** 未命中信号、被抽中评的轮。 */
  sampledTurns: number;
  /** 只记了信号、没调 judge 的轮。 */
  signalOnlyTurns: number;
  /** 已有分数、本轮跳过的轮。 */
  skippedTurns: number;
  costUsd: number;
  /** 叫了打分模型但它没给出判决的轮数（没配好 / 报错 / 返回格式解析不了）。 */
  judgeUnavailableTurns: number;
  /** 因日预算或抽样上限提前停评。 */
  budgetStopped: boolean;
  /** 同一个库上已有一次评分在跑（CLI 与应用内按钮并发），本次一轮没评、一分没扣。 */
  locked: boolean;
  dryRun: boolean;
}

/** 渲染层（IPC）的评分请求只认 days，钳到 [1, 30]；预算、抽样、dry-run 一律丢弃走 host 默认——花钱的信任边界不接受渲染层改上限。 */
const POST_LAUNCH_MAX_DAYS = 30;
export function clampPostLaunchScoringRequest(payload: unknown): PostLaunchScoringRequest {
  const days = (payload as { days?: unknown } | undefined)?.days;
  if (typeof days !== 'number' || !Number.isFinite(days)) return {};
  return { days: Math.min(POST_LAUNCH_MAX_DAYS, Math.max(1, Math.floor(days))) };
}
