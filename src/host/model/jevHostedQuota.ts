// ============================================================================
// Neo 托管判官（N-JEV-NEO-KEY）客户端退避状态 —— per-process blocked-until
// ----------------------------------------------------------------------------
// 托管端点回 429 jev_user_daily_limit / 503 jev_global_fuse 后，本进程立刻进入
// blocked-until 退避：到点前 resolveJevRoute() 不再给出托管路由（判官特性按既有
// 无路由路径静默降级），避免每步都打一遍 429。用户日限退避到下一个 UTC 日界，
// 熔断退避 JEV_HOSTED_FUSE_RETRY_AFTER_MS。状态只在内存（进程重启即重试一次，
// 服务端计数才是权威闸门）。降级必须留痕（错题本 2026-08-14）：每个原因每进程
// 至多一条 warn，文本可区分到具体原因。
// ============================================================================

import { JEV_HOSTED_FUSE_RETRY_AFTER_MS } from '../../shared/constants/jevQuestions';
import type { JevHostedBlockReason, JevHostedBlockState } from '../../shared/contract/jev';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('JevHostedQuota');

let blocked: JevHostedBlockState | null = null;
const warnedReasons = new Set<JevHostedBlockReason>();

/** 下一个 UTC 日界（epoch ms）：用户日限的重置点。 */
export function nextUtcDayStart(now: number = Date.now()): number {
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

/** 对外形状（getJevStatus 用）：托管态下总是有值，未退避时两字段为 null。 */
export function readJevHostedBlockForStatus(now: number = Date.now()): JevHostedBlockState | { blockedUntil: null; blockReason: null } {
  return getJevHostedBlock(now) ?? { blockedUntil: null, blockReason: null };
}

/** 进入退避并留痕（每原因每进程至多一条 warn）。 */
export function blockJevHosted(reason: JevHostedBlockReason, now: number = Date.now()): JevHostedBlockState {
  const blockedUntil = reason === 'user_daily_limit'
    ? nextUtcDayStart(now)
    : now + JEV_HOSTED_FUSE_RETRY_AFTER_MS;
  blocked = { blockedUntil, blockReason: reason };
  if (!warnedReasons.has(reason)) {
    warnedReasons.add(reason);
    const text = reason === 'user_daily_limit'
      ? '今日 Neo 云判官额度已用完，退避到下一个 UTC 日界，判官特性降级为普通确认（本进程仅此一条）'
      : `Neo 云判官全局熔断，退避 ${JEV_HOSTED_FUSE_RETRY_AFTER_MS / 60000} 分钟后重试，判官特性降级为普通确认（本进程仅此一条）`;
    logger.warn(`[jev-hosted] ${text}`);
  }
  return blocked;
}

/** 测试复位用：清空退避与 warn 去重表。 */
export function resetJevHostedBlockForTests(): void {
  blocked = null;
  warnedReasons.clear();
}
