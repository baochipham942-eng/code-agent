// ============================================================================
// 停车审批的重启收口（D0 上报的 host 根因，2026-07-27）
//
// 病灶：启动 hydrate 只对 kind='plan'/'launch' 做 orphan，tool_approval /
// directory_access 没有任何启动收尾路径——重启后 DB 残留 pending 行被收件箱
// 渲染成可点按钮，点击落到已丢失的内存 pending 被静默丢弃（「批准点不动」现场）。
// 收件箱的 orphaned 灰态早已存在，缺的只是「谁在启动时打这个标」。
// ============================================================================

import { getPlanApprovalGate } from './planApproval';
import { getSwarmLaunchApprovalGate } from './swarmLaunchApproval';
import { getDatabase } from '../services/core/databaseService';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ParkedApprovalHydration');

/** 停车挂起类审批的 kind 全集；plan/launch 各有自己的 gate hydrate，不在此列。 */
const PARKED_KINDS = ['tool_approval', 'directory_access'] as const;

/**
 * 启动 hydrate 一站式：plan / launch 走各自 gate 的 attachPersistence（行为不变），
 * tool_approval / directory_access 的残留 pending 行直接 fail-closed 拒绝，避免
 * orphaned 灰态永久占住收件箱。返回各类收尾计数（进启动日志）。
 */
export function hydrateApprovalGatesAtBoot(
  repo: PendingApprovalRepository,
  now: number = Date.now(),
): { plan: number; launch: number; parked: number } {
  const plan = getPlanApprovalGate().attachPersistence(repo, now);
  const launch = getSwarmLaunchApprovalGate().attachPersistence(repo, now);
  let parked = 0;
  for (const kind of PARKED_KINDS) {
    parked += repo.rejectPendingAfterRestart(kind, now).length;
  }
  if (plan + launch + parked > 0) {
    logger.warn(
      `Closed approvals from previous process: ${plan} plan(s) + ${launch} launch(es) + ${parked} rejected parked approval(s)`,
    );
  }
  return { plan, launch, parked };
}

/**
 * 兜底：权限响应找不到宿主（orchestrator 不在 / 内存 pending 已丢）时，
 * 把对应的停车审批行 fail-closed 拒绝，避免继续悬在收件箱。
 * 只认 PARKED_KINDS，不碰 plan/launch 行。返回是否真的收掉了一行。
 */
export function closeDeadParkedApproval(requestId: string, now: number = Date.now()): boolean {
  let repo: PendingApprovalRepository;
  try {
    repo = getDatabase().getPendingApprovalRepo();
  } catch {
    return false;
  }
  const row = PARKED_KINDS
    .flatMap((kind) => repo.listByKindAndStatus(kind, 'pending'))
    .find((record) => record.id === requestId);
  if (!row) return false;
  const changes = repo.resolve({
    id: requestId,
    status: 'rejected',
    feedback: 'Auto-rejected: owning run is no longer alive',
    resolvedAt: now,
  });
  if (changes > 0) {
    logger.warn('Parked approval rejected on dead resolve', { requestId, kind: row.kind });
    return true;
  }
  return false;
}
