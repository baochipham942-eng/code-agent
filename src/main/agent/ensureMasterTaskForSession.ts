// ============================================================================
// ensureMasterTaskForSession — Session 启动时自动建/挂 MasterTask（P3-c1）
// ============================================================================
//
// 在每次 session 真正进入 active 状态（agentOrchestrator.sendMessage 的入口）
// 调用一次：
//   - 已绑 master 且 master 仍存在 → 仅 attachSession（幂等）
//   - 已绑 master 但 master 不存在（DB 不一致 / master 被 hard delete）→ log warn
//     后 fall through 重建一个新的 master，写回 sessions.master_task_id
//   - 未绑 master → register + attachSession + 写回 sessions.master_task_id
//
// 调用契约：
//   - 不抛错路径：写回 master_task_id 失败时只 log warn（master 在内存 OK，
//     下一次 sendMessage 会再走一次"未绑路径"重新写回，最终 DB 一致）。
//   - 抛错路径：manager.register 本身抛错时不吞，让调用方知道 master 子系统挂了。
//
// 不在这里做的事：
//   - P3-c2 backfill（启动期扫已有 session 集中补建）—— 独立 commit。
//   - P3-c3 spawn_agent 关联（子 agent 与 master 的 parent 链）—— 独立 commit。
// ============================================================================

import { getMasterTaskManager } from './masterTaskManager';
import type { SessionRepository } from '../services/core/repositories/SessionRepository';
import type { MasterTask } from './masterTask';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EnsureMasterTaskForSession');

const DEFAULT_OWNER = 'local';

export interface EnsureMasterTaskInput {
  sessionId: string;
  /** Session 标题；空字符串 fallback 为 `Session <id-prefix>` */
  title: string;
  /** Session 工作目录；null/undefined 时 workspaceUri 设为 '' */
  workingDirectory: string | null | undefined;
  /** Session 当前的 master_task_id（DB 列），null/undefined 都视为未绑 */
  existingMasterTaskId: string | null | undefined;
  /** 默认 'local' */
  ownerUserId?: string;
}

export interface EnsureMasterTaskDeps {
  /**
   * SessionRepository（或 DatabaseService）：只用 updateMasterTaskId，
   * 提供窄接口便于测试 mock 不必构造整个 repo。
   */
  sessionRepo: Pick<SessionRepository, 'updateMasterTaskId'>;
}

/**
 * 确保 session 关联一个 MasterTask。返回 MasterTask 实例（永不 null，
 * 除非 manager.register 抛错由调用方处理）。
 */
export function ensureMasterTaskForSession(
  input: EnsureMasterTaskInput,
  deps: EnsureMasterTaskDeps,
): MasterTask {
  const manager = getMasterTaskManager();
  const { sessionId, title, workingDirectory, existingMasterTaskId, ownerUserId } = input;

  // 1) 已绑 master 路径：master 仍在 → 只 attachSession 幂等
  if (existingMasterTaskId) {
    const existing = manager.getById(existingMasterTaskId);
    if (existing) {
      manager.attachSession(existing.id, sessionId);
      return existing;
    }
    // 已绑但 master 不存在（DB 不一致）：log warn 并 fall through 建新的
    logger.warn(
      `session ${sessionId} bound to missing master ${existingMasterTaskId}, creating a new one`,
    );
  }

  // 2) 未绑（或绑死链路）→ register 新 master
  const resolvedTitle = title && title.trim().length > 0
    ? title
    : `Session ${sessionId.slice(0, 8)}`;

  const master = manager.register({
    title: resolvedTitle,
    workspaceUri: workingDirectory ?? '',
    ownerUserId: ownerUserId ?? DEFAULT_OWNER,
  });
  manager.attachSession(master.id, sessionId);

  // 3) 写回 sessions.master_task_id
  try {
    deps.sessionRepo.updateMasterTaskId(sessionId, master.id);
  } catch (err) {
    // 不抛错：master 在内存 OK，DB 不同步下次 sendMessage 会再尝试。
    logger.warn(
      `Failed to write master_task_id back to session ${sessionId}; master kept in-memory only`,
      err,
    );
  }

  return master;
}
