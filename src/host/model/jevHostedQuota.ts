// ============================================================================
// Neo 托管判官（N-JEV-NEO-KEY）客户端退避状态 —— per-process blocked-until
// ----------------------------------------------------------------------------
// 托管端点回 429 jev_user_daily_limit / 503 jev_global_fuse，或出现持续性服务故障
// （401/404/其它 5xx/网络失败/超时）后，本进程立刻进入
// blocked-until 退避：到点前 resolveJevRoute() 不再给出托管路由（判官特性按既有
// 无路由路径静默降级），避免每步都打一遍 429。用户日限退避到下一个 UTC 日界，
// 熔断退避 JEV_HOSTED_FUSE_RETRY_AFTER_MS。状态只在内存（进程重启即重试一次，
// 服务端计数才是权威闸门）。降级必须留痕（错题本 2026-08-14）：每个原因每进程
// 至多一条 warn，文本可区分到具体原因。
// ============================================================================

import { JEV_HOSTED_FUSE_RETRY_AFTER_MS } from '../../shared/constants/jevQuestions';
import { JEV_HOSTED_TIMEOUTS } from '../../shared/constants/timeouts';
import type { JevHostedBlockReason, JevHostedBlockState, JevHostedStatus } from '../../shared/contract/jev';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('JevHostedQuota');

let blocked: JevHostedBlockState | null = null;
const warnedReasons = new Set<JevHostedBlockReason>();

/** 下一个 UTC 日界（epoch ms）：用户日限的重置点。 */
function nextUtcDayStart(now: number = Date.now()): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor(now / dayMs) * dayMs + dayMs;
}

/** 当前是否处于退避中（到点自动视作解除，无需显式清除）。 */
export function getJevHostedBlock(now: number = Date.now()): JevHostedBlockState | null {
  if (blocked && blocked.blockedUntil > now) {
    return blocked;
  }
  return null;
}

/** 对外形状（getJevStatus.hosted 用）：资格 + 退避状态合并成状态切片。 */
export function readJevHostedBlockForStatus(eligible: boolean, now: number = Date.now()): JevHostedStatus {
  const block = getJevHostedBlock(now);
  return block
    ? { eligible, blockedUntil: block.blockedUntil, blockReason: block.blockReason }
    : { eligible, blockedUntil: null, blockReason: null };
}

/** 进入退避并留痕（每原因每进程至多一条 warn；detail 只进首条 warn，用于区分是哪类故障）。 */
export function blockJevHosted(reason: JevHostedBlockReason, now: number = Date.now(), detail?: string): JevHostedBlockState {
  const blockedUntil = reason === 'user_daily_limit'
    ? nextUtcDayStart(now)
    : now + (reason === 'global_fuse' ? JEV_HOSTED_FUSE_RETRY_AFTER_MS : JEV_HOSTED_TIMEOUTS.SERVICE_FAILURE_BACKOFF);
  blocked = { blockedUntil, blockReason: reason };
  if (!warnedReasons.has(reason)) {
    warnedReasons.add(reason);
    const text = reason === 'user_daily_limit'
      ? '今日 Neo 云判官额度已用完，退避到下一个 UTC 日界，判官特性降级为普通确认（本进程仅此一条）'
      : reason === 'global_fuse'
        ? `Neo 云判官全局熔断，退避 ${JEV_HOSTED_FUSE_RETRY_AFTER_MS / 60000} 分钟后重试，判官特性降级为普通确认（本进程仅此一条）`
        : `Neo 云判官服务不可用（${detail ?? 'unknown'}），退避 ${JEV_HOSTED_TIMEOUTS.SERVICE_FAILURE_BACKOFF / 60000} 分钟后重试，判官特性降级为普通确认（本进程仅此一条）`;
    logger.warn(`[jev-hosted] ${text}`);
  }
  return blocked;
}
