// ============================================================================
// 通话时长记账（批 H · 方案 §5.4 双轨的 voice_minutes 一侧）
//
// 只记账、不设限——产品负责人 2026-07-27 拍板：Phase 0 实测 11 通通话 < ¥0.05，
// 真实约束在执行侧的 agent run，voice_minutes 轨放宽。
//
// 为什么不进 usage_ledger：那张表是 token 形状（input/outputTokens），通话按音频时长计费，
// 硬塞进去就是假数据。为什么不新建表：为一个还没有消费方的数字加迁移是投机建设。
// 用既有的偏好 KV 存按月桶——零迁移、可按「这个月」查询，一年也就 12 个键。
// ============================================================================

import { createLogger } from '../infra/logger';
import { getDatabase } from '../core/databaseService';

const logger = createLogger('VoiceUsage');

const PREFERENCE_KEY = 'voice.usage.monthly';

/** failedAttempts 可缺失：存量 preference JSON 只有 seconds/calls。 */
type VoiceUsageBucket = { seconds: number; calls: number; failedAttempts?: number };
export type VoiceUsageBuckets = Record<string, VoiceUsageBucket>;

export interface VoiceUsageSummary {
  monthSeconds: number;
  monthCalls: number;
  monthFailedAttempts: number;
}

/** 月份键取本地时区——用户看到的「这个月」是他自己日历上的这个月。 */
export function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function readBuckets(): VoiceUsageBuckets {
  try {
    return getDatabase().getPreference<VoiceUsageBuckets>(PREFERENCE_KEY) ?? {};
  } catch {
    return {};
  }
}

/**
 * 纯函数形式的累加，供单测钉住跨月/首次/累积三种情形。
 */
export function accumulate(buckets: VoiceUsageBuckets, at: number, seconds: number): VoiceUsageBuckets {
  if (seconds <= 0) return buckets;
  const key = monthKey(at);
  const current = buckets[key] ?? { seconds: 0, calls: 0, failedAttempts: 0 };
  return {
    ...buckets,
    [key]: {
      seconds: current.seconds + seconds,
      calls: current.calls + 1,
      failedAttempts: current.failedAttempts ?? 0,
    },
  };
}

/** 失败尝试只进分母，不给真实通话时长编数字。 */
export function accumulateFailure(buckets: VoiceUsageBuckets, at: number): VoiceUsageBuckets {
  const key = monthKey(at);
  const current = buckets[key] ?? { seconds: 0, calls: 0, failedAttempts: 0 };
  return {
    ...buckets,
    [key]: {
      seconds: current.seconds,
      calls: current.calls,
      failedAttempts: (current.failedAttempts ?? 0) + 1,
    },
  };
}

/** 通话结束时记一笔。best-effort：记账失败绝不影响挂断流程。 */
export function recordVoiceCall(endedAt: number, durationSec: number): void {
  if (durationSec <= 0) return;
  try {
    getDatabase().setPreference(PREFERENCE_KEY, accumulate(readBuckets(), endedAt, durationSec));
  } catch (err) {
    logger.warn('failed to record voice usage', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

/** 一次失败拨号/中断记入独立分母。best-effort，不影响错误呈现。 */
export function recordVoiceCallFailure(failedAt: number): void {
  try {
    getDatabase().setPreference(PREFERENCE_KEY, accumulateFailure(readBuckets(), failedAt));
  } catch (err) {
    logger.warn('failed to record voice failure', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

export function summarize(buckets: VoiceUsageBuckets, now: number): VoiceUsageSummary {
  const bucket = buckets[monthKey(now)];
  return {
    monthSeconds: bucket?.seconds ?? 0,
    monthCalls: bucket?.calls ?? 0,
    monthFailedAttempts: bucket?.failedAttempts ?? 0,
  };
}

/** 本月用量。读失败按 0 返回——这个数字只用于展示，不做任何拦截。 */
export function getVoiceUsageSummary(now: number): VoiceUsageSummary {
  return summarize(readBuckets(), now);
}
