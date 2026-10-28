// ============================================================================
// 停车审批的重启收口（D0 上报的 host 根因，2026-07-27）
//
// 病灶：启动 hydrate 只对 kind='plan'/'launch' 做 orphan，tool_approval /
// directory_access / channel_pairing 没有任何启动收尾路径——重启后 DB 残留 pending 行被收件箱
// 渲染成可点按钮，点击落到已丢失的内存 pending 被静默丢弃（「批准点不动」现场）。
// 收件箱的 orphaned 灰态早已存在，缺的只是「谁在启动时打这个标」。
//
// N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME（A′）：tool_approval 里满足存活判据的行不再
// 一刀切拒绝——保持 pending、标题改「重启前发起 · <tool>」、该会话的 durable run 停靠成
// waiting + guard_halt（不自动续跑）；批准走 parkedApprovalResume 从台账执行一次。
// 其余（超 24h / 参数不可恢复 / directory_access / channel_pairing）照旧 fail-closed 拒绝。
// ============================================================================

import type { Message } from '../../shared/contract';
import type { PendingApprovalRecord, ToolApprovalPayload } from '../../shared/contract/pendingApproval';
import { getPlanApprovalGate } from './planApproval';
import { getSwarmLaunchApprovalGate } from './swarmLaunchApproval';
import { getDatabase } from '../services/core/databaseService';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import type { DurableRunRepository } from '../services/core/repositories/DurableRunRepository';
import { createLogger } from '../services/infra/logger';
import {
  classifyParkedToolApprovalForSurvival,
  parseParkedApprovalPayload,
} from './parkedApprovalSurvival';

const logger = createLogger('ParkedApprovalHydration');

/** 停车挂起类审批的 kind 全集；plan/launch 各有自己的 gate hydrate，不在此列。 */
const PARKED_KINDS = ['tool_approval', 'directory_access', 'channel_pairing'] as const;

interface ParkedApprovalHydrationDeps {
  /** 幸存判据要读会话台账；缺省（测试/DB 未就绪）时 tool_approval 一律按不可存活收口。 */
  loadSessionMessages?: (sessionId: string) => Message[] | null;
  /**
   * 会话工作目录解析（N-...-RESUME-FU1）：幸存行批准后要从台账重放执行，解析不出 cwd 的
   * 行在启动时就收口，不留「看着能点、点了被拒」的死卡。缺省直读会话记录
   * （getSession 不带 owner 过滤，与点击恢复的 resolveWorkingDirectory 同口径）。
   */
  resolveWorkingDirectory?: (sessionId: string) => string | null;
  /**
   * 幸存行停靠用的 durable run 仓储（缺省走 getDatabase().getDurableRunRepository()）。
   * 显式注入只为让合同测试钉「guard_halt 停靠不进 listRecoverable」走真实 hydrate 入口。
   */
  durableRunRepository?: DurableRunRepository;
}

/**
 * 启动 hydrate 一站式：plan / launch 走各自 gate 的 attachPersistence（行为不变）；
 * tool_approval 按存活判据分流（幸存保持 pending 并标记「重启前发起」，其余按
 * expired_after_restart_24h / args_unavailable 收口）；directory_access /
 * channel_pairing 直接 fail-closed 拒绝。返回各类收尾计数（进启动日志）。
 */
export function hydrateApprovalGatesAtBoot(
  repo: PendingApprovalRepository,
  now: number = Date.now(),
  deps: ParkedApprovalHydrationDeps = {},
): { plan: number; launch: number; parked: number; survived: number } {
  const plan = getPlanApprovalGate().attachPersistence(repo, now);
  const launch = getSwarmLaunchApprovalGate().attachPersistence(repo, now);
  const loadSessionMessages = deps.loadSessionMessages ?? defaultLoadSessionMessages();
  const resolveWorkingDirectory = deps.resolveWorkingDirectory ?? defaultResolveWorkingDirectory();
  const parkSessionDurableRuns = (sessionId: string, at: number) => {
    let repository: DurableRunRepository | null = deps.durableRunRepository ?? null;
    if (!repository) {
      try {
        repository = getDatabase().getDurableRunRepository();
      } catch {
        return;
      }
    }
    parkSessionDurableRunsForApproval(repository, sessionId, at);
  };

  const survivors: string[] = [];
  let parked = 0;
  for (const row of repo.listByKindAndStatus('tool_approval', 'pending')) {
    const payload = parseParkedApprovalPayload(row.payloadJson);
    const sessionId = payload?.argsRef?.sessionId ?? payload?.sessionId ?? row.coordinatorId ?? null;
    const messages = sessionId ? loadSessionMessages(sessionId) : null;
    const verdict = classifyParkedToolApprovalForSurvival({
      payload,
      now,
      messages,
      // sessionId 都没有的行连台账都读不到（上面 messages=null 已判 args_unavailable）；
      // 这里传 null 而非 undefined：hydrate 是权威判定方，解析不出就要收口。
      workingDirectory: sessionId ? resolveWorkingDirectory(sessionId) : null,
    });
    if (verdict.survive) {
      survivors.push(row.id);
      markSurvivorRestartOrigin(repo, row, payload);
      if (sessionId) parkSessionDurableRuns(sessionId, now);
      continue;
    }
    const changes = repo.resolve({
      id: row.id,
      status: 'rejected',
      feedback: verdict.detail === 'working_directory_unavailable'
        ? `Auto-rejected after restart: ${verdict.reason} (session working directory unavailable)`
        : `Auto-rejected after restart: ${verdict.reason}`,
      resolvedAt: now,
    });
    parked += changes;
  }
  // 旧版本遗留的 orphaned 行 + 竞态漏网的 pending 行统一兜底收口（幸存行排除在外）。
  parked += repo.rejectPendingAfterRestart('tool_approval', now, survivors).length;
  for (const kind of ['directory_access', 'channel_pairing'] as const) {
    parked += repo.rejectPendingAfterRestart(kind, now).length;
  }
  if (plan + launch + parked > 0) {
    logger.warn(
      `Closed approvals from previous process: ${plan} plan(s) + ${launch} launch(es) + ${parked} rejected parked approval(s)`,
    );
  }
  if (survivors.length > 0) {
    logger.warn(
      `Kept ${survivors.length} parked tool approval(s) pending across restart (approvable from the message ledger for 24h)`,
    );
  }
  return { plan, launch, parked, survived: survivors.length };
}

/** 幸存行的收件箱标题：displayTool 前缀「重启前发起」，其余 payload 原样保留。 */
function markSurvivorRestartOrigin(
  repo: PendingApprovalRepository,
  row: PendingApprovalRecord,
  payload: Partial<ToolApprovalPayload> | null,
): void {
  const tool = payload?.displayTool ?? payload?.tool ?? 'unknown';
  const marked = `重启前发起 · ${tool}`;
  try {
    repo.insert({
      id: row.id,
      kind: 'tool_approval',
      agentId: row.agentId,
      agentName: row.agentName,
      coordinatorId: row.coordinatorId,
      payload: { ...payload, displayTool: marked },
      submittedAt: row.submittedAt,
    });
  } catch (err) {
    logger.warn(`Failed to mark surviving parked approval ${row.id}`, err);
  }
}

function defaultLoadSessionMessages(): (sessionId: string) => Message[] | null {
  return (sessionId: string) => {
    try {
      return getDatabase().getMessages(sessionId);
    } catch {
      return null;
    }
  };
}

/**
 * 与点击恢复（parkedApprovalResume 的 resolveWorkingDirectory）同口径：直读会话记录，
 * 不带 owner 过滤——owner-scoped 查询在重启后可能因当前 owner 不匹配而错失会话，
 * 把可执行的行误判成「没有工作目录」。查询失败同样按解析不出收口（fail-closed）。
 */
function defaultResolveWorkingDirectory(): (sessionId: string) => string | null {
  return (sessionId: string) => {
    try {
      return getDatabase().getSession(sessionId)?.workingDirectory || null;
    } catch {
      return null;
    }
  };
}

/**
 * 幸存行所属会话的 durable run 停靠（item 3）：waiting + guard_halt，让启动清扫把它当
 * 「显式停靠」走 listParkedForReclaim（resumeBlocked），绝不自动续跑（K2）。复用既有仓储
 * 路径（listActiveRunRoster → get → listPendingOperations → replaceRecoveryProjection，
 * owner/attempt fence 原样校验），不新增仓储方法。better-sqlite3 的异步方法体同步执行，
 * fire-and-forget 的写盘仍先于任何清扫 tick（清扫在 capabilityBootstrap 之后才起步）。
 */
function parkSessionDurableRunsForApproval(
  repository: DurableRunRepository,
  sessionId: string,
  now: number,
): void {
  void repository.listActiveRunRoster().then(async (roster) => {
    for (const entry of roster) {
      if (entry.sessionId !== sessionId) continue;
      try {
        const envelope = await repository.get(entry.runId);
        if (!envelope?.owner) continue;
        const pendingOperations = await repository.listPendingOperations(entry.runId);
        await repository.replaceRecoveryProjection({
          runId: entry.runId,
          attempt: envelope.attempt,
          expectedOwnerEpoch: envelope.owner.epoch,
          status: 'waiting',
          pendingOperations,
          interruptCause: 'guard_halt',
          autoResumeCount: envelope.autoResumeCount ?? 0,
          updatedAt: now,
        });
        logger.info('Parked durable run guarded for surviving approval', {
          runId: entry.runId,
          sessionId,
        });
      } catch (error) {
        logger.warn('Failed to park durable run for surviving approval', {
          runId: entry.runId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }).catch((error: unknown) => logger.warn('Failed to list durable run roster for surviving approval', {
    sessionId,
    error: error instanceof Error ? error.message : String(error),
  }));
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
