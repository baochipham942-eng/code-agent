// ============================================================================
// 停车审批的重启收口（D0 上报的 host 根因，2026-07-27）
//
// 病灶：启动 hydrate 只对 kind='plan'/'launch' 做 orphan，tool_approval /
// directory_access 没有任何启动 orphan 路径——重启后 DB 残留 pending 行被收件箱
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
 * tool_approval / directory_access 的残留 pending 行同等标 orphaned。
 * 返回各类 orphan 计数（进启动日志）。
 */
export function hydrateApprovalGatesAtBoot(
  repo: PendingApprovalRepository,
  now: number = Date.now(),
): { plan: number; launch: number; parked: number } {
  const plan = getPlanApprovalGate().attachPersistence(repo, now);
  const launch = getSwarmLaunchApprovalGate().attachPersistence(repo, now);
  let parked = 0;
  for (const kind of PARKED_KINDS) {
    parked += repo.markPendingAsOrphaned(kind, now).length;
  }
  if (plan + launch + parked > 0) {
    logger.warn(
      `Orphaned approvals from previous process: ${plan} plan(s) + ${launch} launch(es) + ${parked} parked tool approval(s)`,
    );
  }
  return { plan, launch, parked };
}

/**
 * 兜底：权限响应找不到宿主（orchestrator 不在 / 内存 pending 已丢）时，
 * 把对应的停车审批行标 orphaned——收件箱下次加载转灰态，而不是永远挂着假按钮。
 * 只认 PARKED_KINDS，不碰 plan/launch 行。返回是否真的收掉了一行。
 */
export function orphanDeadParkedApproval(requestId: string, now: number = Date.now()): boolean {
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
    status: 'orphaned',
    feedback: 'Orphaned: owning run no longer alive',
    resolvedAt: now,
  });
  if (changes > 0) {
    logger.warn('Parked approval orphaned on dead resolve', { requestId, kind: row.kind });
    return true;
  }
  return false;
}
