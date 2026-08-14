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
  CapabilityCandidateView,
} from '../../../shared/contract/capabilityCandidate';
import type { ComboStep } from './comboRecorder';
import { getCapabilityCandidateStore } from './capabilityCandidateStore';
import {
  clusterKeyOf,
  decayCount,
  detectDegraded,
  detectMissingHint,
  findClusterFor,
  hasWorkaroundSignature,
  mechanicalScoreOf,
  runTierTests,
  sequenceShapeOf,
  tierOf,
} from './capabilityGapScoring';
import { createLogger } from '../infra/logger';

const logger = createLogger('CapabilityGapDetector');

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
  const shapeTokens = [...new Set(shapeSequence)].sort();
  // 单工具不是拼凑，是在用工具——不进账本
  if (shapeTokens.length < CAPABILITY_CANDIDATES.MIN_DISTINCT_TOOLS) return null;

  const store = getCapabilityCandidateStore();
  const clusterKey = findClusterFor(shapeTokens, store.list()) ?? clusterKeyOf(shapeSequence);
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
    // 归并进已有簇时保持代表集合不变，防止簇一路漂移成大杂烩
    shapeTokens: previous?.shapeTokens ?? shapeTokens,
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

function toView(record: CapabilityCandidateRecord, now: number): CapabilityCandidateView {
  const mechanicalScore = mechanicalScoreOf(record, now);
  const cooledDown = record.state === 'ignored'
    && (!record.ignoredUntil || now >= record.ignoredUntil);
  return {
    ...record,
    mechanicalScore,
    aboveFold: record.state !== 'dismissed'
      && (record.state !== 'ignored' || cooledDown)
      && hasWorkaroundSignature(record.shapeTokens)
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
