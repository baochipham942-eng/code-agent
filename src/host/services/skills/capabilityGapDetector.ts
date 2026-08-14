// ============================================================================
// CapabilityGapDetector — 缺口探测器（N-CAP1 / F1）
// ============================================================================
// 本体不是「找它缺什么」（模型嘴上说缺不可信，成功绕过时又不说），
// 而是「找它反复在做什么」（全部可观测）——所以原料是真实执行序列。
//
// 三件事，全部机械、可复算、可解释：
//   ① 信号采集 S1 重复同构拼凑 / S2 降级完成 / S3 显式缺失
//   ② 去参数化 → 意图簇：每步压成 shape token，簇 = 去重排序后的 token 集合
//   ③ 机械分增量更新：score = n̂ × 单次成本 × 可参数化度，n̂ 带时间衰减
//
// 模型只负责起人话名与一句说明（capabilityCandidateNaming.ts），
// **绝不参与排序**——让它写描述，错了人一眼看出；让它定优先级，错了人看不出。

import { CAPABILITY_CANDIDATES } from '../../../shared/constants';
import type {
  CapabilityCandidateRecord,
  CapabilityCandidateTier,
  CapabilityCandidateTierTests,
  CapabilityCandidateView,
} from '../../../shared/contract/capabilityCandidate';
import type { ComboStep, ComboTurn } from './comboRecorder';
import { getCapabilityCandidateStore } from './capabilityCandidateStore';
import { createLogger } from '../infra/logger';

const logger = createLogger('CapabilityGapDetector');

// ---------------------------------------------------------------------------
// ② 去参数化
// ---------------------------------------------------------------------------

/**
 * 一步 → shape token（去掉全部参数，只留「用了什么」）。
 *
 * bash 单独细分到 argv0：拼凑几乎都是 bash 驱动的，只记 "bash" 会把
 * `screencapture` 和 `ffmpeg` 归成同一簇，聚类立刻失去判别力。
 */
export function shapeOfStep(step: Pick<ComboStep, 'toolName' | 'args'>): string {
  const toolName = (step.toolName || 'unknown').trim();
  if (!isShellTool(toolName)) return toolName;

  const command = firstStringArg(step.args, ['command', 'cmd', 'script']);
  const head = commandHead(command);
  return head ? `${toolName}:${head}` : toolName;
}

function isShellTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === 'bash' || lower === 'shell' || lower === 'run_command';
}

function firstStringArg(args: Record<string, unknown> | undefined, keys: string[]): string {
  if (!args) return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * 取命令的可执行名：丢掉 env 前缀、路径、参数与引号。
 * `HTTPS_PROXY=x /usr/bin/ffmpeg -i a.mp4` → `ffmpeg`
 */
export function commandHead(command: string): string {
  const firstSegment = command.split(/[|;&\n]/)[0] ?? '';
  for (const rawToken of firstSegment.trim().split(/\s+/)) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (!token) continue;
    // `KEY=value` 形式的环境变量前缀不是可执行名
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token === 'sudo' || token === 'env' || token === 'command') continue;
    const base = token.split('/').pop() ?? token;
    if (base) return base.toLowerCase();
  }
  return '';
}

/** 一轮的步骤顺序（去参数化 + 去掉连续重复），用于算变异度 */
export function sequenceShapeOf(steps: Array<Pick<ComboStep, 'toolName' | 'args'>>): string[] {
  const shapes: string[] = [];
  for (const step of steps) {
    const shape = shapeOfStep(step);
    if (shapes[shapes.length - 1] !== shape) shapes.push(shape);
  }
  return shapes;
}

/**
 * 意图簇键 = 去重排序后的 shape token 集合。
 *
 * 为什么是「集合」而不是「序列」：序列做键会把同一件事的不同做法切成好几簇，
 * 分数被摊薄；而簇内保留各条序列，正好给出可参数化度（变异度倒数）。
 * 列表要展示的「凭什么把这几次归成一条」，就是这个集合本身。
 */
export function clusterKeyOf(shapeSequence: string[]): string {
  return [...new Set(shapeSequence)].sort().join(' + ');
}

// ---------------------------------------------------------------------------
// ① 信号采集
// ---------------------------------------------------------------------------

/** S3：错误文本里「因为没有 X」的形态。命中即判「要现有工具集之外的东西」。 */
const MISSING_DEPENDENCY_PATTERNS: RegExp[] = [
  /command not found/i,
  /no such file or directory/i,
  /not (?:installed|available|supported|recognized)/i,
  /is unavailable/i,
  /unknown (?:tool|command)/i,
  /未安装|不可用|找不到命令|不支持该操作/,
];

export function detectMissingHint(step: Pick<ComboStep, 'success' | 'outputPreview'>): string | null {
  if (step.success) return null;
  const text = step.outputPreview ?? '';
  for (const pattern of MISSING_DEPENDENCY_PATTERNS) {
    if (pattern.test(text)) return text.trim().slice(0, 120);
  }
  return null;
}

/** S2：某步失败后换了另一种工具并成功 —— 产物打折但还是交付了 */
export function detectDegraded(steps: Array<Pick<ComboStep, 'success' | 'toolName' | 'args'>>): boolean {
  const failedIndex = steps.findIndex((step) => !step.success);
  if (failedIndex < 0) return false;
  const failedShape = shapeOfStep(steps[failedIndex]);
  return steps
    .slice(failedIndex + 1)
    .some((step) => step.success && shapeOfStep(step) !== failedShape);
}

// ---------------------------------------------------------------------------
// ③ 机械分
// ---------------------------------------------------------------------------

/** 时间衰减后的重复度：读时与写时用同一个函数，保证列表与账本口径一致 */
export function decayCount(count: number, elapsedMs: number): number {
  if (!(count > 0)) return 0;
  if (!(elapsedMs > 0)) return count;
  return count * Math.pow(0.5, elapsedMs / CAPABILITY_CANDIDATES.DECAY_HALF_LIFE_MS);
}

/** 单次成本：步数 × token（拿不到用量时退化为纯步数，不假装有数据） */
export function unitCostOf(avgSteps: number, avgTokens: number): number {
  const tokenFactor = avgTokens > 0 ? avgTokens / 1000 : 1;
  return Math.max(avgSteps, 1) * Math.max(tokenFactor, 1);
}

/** 可参数化度 = 变异度倒数：只有一种步骤顺序 ⇒ 1（最可参数化） */
export function parameterizabilityOf(variantCount: number): number {
  return 1 / Math.max(variantCount, 1);
}

/**
 * 机械分（排序主键）。**模型分不出现在这个函数里，这是硬约束。**
 * 传入 now 以便读时把衰减算进去（久未复现自动下沉，不需要跑批任务）。
 */
export function mechanicalScoreOf(record: CapabilityCandidateRecord, now: number): number {
  const decayed = decayCount(record.decayedCount, now - record.lastSeenAt);
  return decayed
    * unitCostOf(record.avgSteps, record.avgTokens)
    * parameterizabilityOf(record.variants.length);
}

// ---------------------------------------------------------------------------
// 沉淀层级路由 · 三测试
// ---------------------------------------------------------------------------

export function runTierTests(record: Omit<CapabilityCandidateRecord, 'tests' | 'tier'>): CapabilityCandidateTierTests {
  const variance = record.variants.length / Math.max(record.occurrences, 1);
  return {
    deterministic: variance <= CAPABILITY_CANDIDATES.DETERMINISTIC_VARIANCE_MAX,
    // 边界靠证据（S3 真的报了「没有 X」），不靠「哪些命令算外部」的名字清单——
    // 按名字枚举的清单会静默漏掉没列进去的东西。
    needsExternal: record.signals.missingDependency,
    faultProne: record.failureRate > CAPABILITY_CANDIDATES.FAULT_PRONE_FAILURE_RATE,
  };
}

export function tierOf(tests: CapabilityCandidateTierTests): CapabilityCandidateTier {
  if (tests.needsExternal || tests.faultProne) return 'plugin';
  return tests.deterministic ? 'workflow' : 'skill';
}

// ---------------------------------------------------------------------------
// 观测入口
// ---------------------------------------------------------------------------

export interface ObservedTurn {
  userMessage: string;
  steps: ComboStep[];
  /** 本轮消耗的 token（输入+输出）；拿不到传 0，不要编 */
  tokens: number;
}

/** 运行均值：不重算全量历史，只用「旧均值 + 新样本」更新 */
function runningMean(previous: number, sample: number, previousCount: number): number {
  return previous + (sample - previous) / (previousCount + 1);
}

/**
 * 观测一轮拼凑并**增量更新**对应候选。
 * 每发生一次同类拼凑就更新一次分数与证据 —— 不是跑批快照。
 */
export function observeTurn(turn: ObservedTurn, now: number): CapabilityCandidateRecord | null {
  const steps = turn.steps ?? [];
  if (steps.length < CAPABILITY_CANDIDATES.MIN_STEPS_PER_TURN) return null;

  const shapeSequence = sequenceShapeOf(steps);
  const clusterKey = clusterKeyOf(shapeSequence);
  if (!clusterKey) return null;

  const store = getCapabilityCandidateStore();
  const previous = store.get(clusterKey);

  const missingHint = steps.map(detectMissingHint).find((hint): hint is string => Boolean(hint));
  const failureRateSample = steps.filter((step) => !step.success).length / steps.length;
  const wallclockSample = steps.reduce((sum, step) => sum + (step.duration || 0), 0);
  const previousCount = previous?.occurrences ?? 0;
  const sequenceLabel = shapeSequence.join(' → ');

  const variants = previous ? [...previous.variants] : [];
  if (!variants.includes(sequenceLabel) && variants.length < CAPABILITY_CANDIDATES.MAX_VARIANTS) {
    variants.push(sequenceLabel);
  }

  const sampleUserMessages = previous ? [...previous.sampleUserMessages] : [];
  const trimmedMessage = (turn.userMessage || '').trim().slice(0, 120);
  if (trimmedMessage
    && trimmedMessage !== '(auto)'
    && !sampleUserMessages.includes(trimmedMessage)
    && sampleUserMessages.length < CAPABILITY_CANDIDATES.MAX_SAMPLE_MESSAGES) {
    sampleUserMessages.push(trimmedMessage);
  }

  const missingHints = previous ? [...previous.signals.missingHints] : [];
  if (missingHint
    && !missingHints.includes(missingHint)
    && missingHints.length < CAPABILITY_CANDIDATES.MAX_MISSING_HINTS) {
    missingHints.push(missingHint);
  }

  const base: Omit<CapabilityCandidateRecord, 'tests' | 'tier'> = {
    clusterKey,
    shapeTokens: [...new Set(shapeSequence)].sort(),
    variants,
    occurrences: previousCount + 1,
    // 增量：把旧值按上次出现到现在的间隔衰减，再 +1。不回放历史。
    decayedCount: previous ? decayCount(previous.decayedCount, now - previous.lastSeenAt) + 1 : 1,
    avgSteps: previous ? runningMean(previous.avgSteps, steps.length, previousCount) : steps.length,
    avgTokens: previous ? runningMean(previous.avgTokens, turn.tokens, previousCount) : turn.tokens,
    avgWallclockMs: previous ? runningMean(previous.avgWallclockMs, wallclockSample, previousCount) : wallclockSample,
    failureRate: previous ? runningMean(previous.failureRate, failureRateSample, previousCount) : failureRateSample,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    signals: {
      repeated: previousCount + 1 > 1,
      degraded: (previous?.signals.degraded ?? false) || detectDegraded(steps),
      missingDependency: (previous?.signals.missingDependency ?? false) || Boolean(missingHint),
      missingHints,
    },
    // 「不再提示」是终态，再次发生也不复活；「忽略」到期后回到列表。
    state: resolveState(previous, now),
    ignoredUntil: previous?.ignoredUntil,
    dismissedAt: previous?.dismissedAt,
    displayName: previous?.displayName,
    summary: previous?.summary,
    sampleUserMessages,
  };

  const tests = runTierTests(base);
  const record: CapabilityCandidateRecord = { ...base, tests, tier: tierOf(tests) };

  store.put(record);
  store.prune((entry) => mechanicalScoreOf(entry, now));
  return record;
}

function resolveState(
  previous: CapabilityCandidateRecord | undefined,
  now: number,
): CapabilityCandidateRecord['state'] {
  if (!previous) return 'active';
  if (previous.state === 'dismissed') return 'dismissed';
  if (previous.state === 'ignored' && previous.ignoredUntil && now < previous.ignoredUntil) return 'ignored';
  return 'active';
}

// ---------------------------------------------------------------------------
// 读取面（人与 agent 共用同一张表）
// ---------------------------------------------------------------------------

export function toView(record: CapabilityCandidateRecord, now: number): CapabilityCandidateView {
  const mechanicalScore = mechanicalScoreOf(record, now);
  const cooledDown = record.state === 'ignored'
    && (!record.ignoredUntil || now >= record.ignoredUntil);
  return {
    ...record,
    mechanicalScore,
    aboveFold: record.state !== 'dismissed'
      && (record.state !== 'ignored' || cooledDown)
      && record.occurrences >= CAPABILITY_CANDIDATES.ABOVE_FOLD_MIN_OCCURRENCES
      && mechanicalScore >= CAPABILITY_CANDIDATES.ABOVE_FOLD_MIN_SCORE,
  };
}

/** 列表：机械分降序。**排序表达式里没有任何模型产出的字段。** */
export function listCandidates(now: number): CapabilityCandidateView[] {
  return getCapabilityCandidateStore()
    .list()
    .filter((record) => record.state !== 'dismissed')
    .map((record) => toView(record, now))
    .sort((a, b) => b.mechanicalScore - a.mechanicalScore);
}

export function setCandidateState(
  clusterKey: string,
  state: 'ignored' | 'dismissed',
  now: number,
): boolean {
  const store = getCapabilityCandidateStore();
  const record = store.get(clusterKey);
  if (!record) return false;
  store.put({
    ...record,
    state,
    ignoredUntil: state === 'ignored' ? now + CAPABILITY_CANDIDATES.IGNORE_COOLDOWN_MS : record.ignoredUntil,
    dismissedAt: state === 'dismissed' ? now : record.dismissedAt,
  });
  logger.info('候选能力状态更新', { clusterKey, state });
  return true;
}
