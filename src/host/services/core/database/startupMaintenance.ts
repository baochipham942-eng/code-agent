// ============================================================================
// 启动期 DB 维护（从 databaseService._doInitialize 抽出，行为不变）
// ============================================================================
// 顺序执行：崩溃会话标记 → 崩溃现场重建（ADR-022 第二期）→ 三个 FTS backfill。
// 都在启动关键路径上，耗时由调用方的 step 计时器记录。

import { buildRecoverySnapshot, acknowledgeRecovery, type RecoverySnapshot } from '../crashRecovery';
import type { SessionRepository } from '../repositories/SessionRepository';
import type { MemoryRepository } from '../repositories/MemoryRepository';
import type { ToolExecutionEventRepository } from '../repositories/ToolExecutionEventRepository';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

/**
 * 分步计时器：DB init 曾在 1.28GB 生产库上静默吃掉 ~6s（health-ready 的大头），
 * 每步耗时落一条 summary 日志，回归时能直接从用户日志定位慢在哪步。
 */
export function createInitStepTimer(): { step: (name: string) => void; summary: () => string } {
  const timings: string[] = [];
  let stepStart = performance.now();
  return {
    step: (name: string): void => {
      const now = performance.now();
      timings.push(`${name}=${Math.round(now - stepStart)}ms`);
      stepStart = now;
    },
    summary: (): string => timings.join(' '),
  };
}

export interface StartupMaintenanceDeps {
  sessionRepo: SessionRepository;
  memoryRepo: MemoryRepository;
  toolExecutionEventRepo: ToolExecutionEventRepository;
  logger: Logger;
  /** 分步计时回调（databaseService 的 init timings 日志） */
  step: (name: string) => void;
}

/** 返回崩溃恢复快照（fail-safe：扫描失败返回 null，不阻塞启动） */
export function runStartupMaintenance(deps: StartupMaintenanceDeps): RecoverySnapshot | null {
  const { sessionRepo, memoryRepo, toolExecutionEventRepo, logger, step } = deps;

  const crashedSessions = sessionRepo.markCrashedActiveSessions(Date.now());
  if (crashedSessions.interrupted > 0 || crashedSessions.orphaned > 0) {
    logger.warn(
      `[DatabaseService] Marked crashed active sessions: ${crashedSessions.interrupted} interrupted, ${crashedSessions.orphaned} orphaned`,
    );
  }

  // ADR-022 第二期 · 崩溃重放：从总账重建"崩溃前正在做的事"（未闭合工具执行），
  // 不再只翻 interrupted 标记。重建后 append recovered 闭合，保证重启幂等。fail-safe。
  let snapshot: RecoverySnapshot | null = null;
  try {
    snapshot = buildRecoverySnapshot(toolExecutionEventRepo, Date.now());
    if (snapshot.totalInFlight > 0) {
      logger.warn(
        `[DatabaseService] Crash recovery: ${snapshot.totalInFlight} in-flight tool execution(s) across ${snapshot.sessions.length} session(s) reconstructed from ledger`,
      );
      acknowledgeRecovery(toolExecutionEventRepo, snapshot, Date.now());
    }
  } catch (err) {
    logger.warn('[DatabaseService] Crash recovery scan failed (ignored):', err);
  }
  step('crash-recovery');

  // 首次升级后：从已有 messages 表 backfill episodic FTS 索引（幂等）
  sessionRepo.backfillSessionMessagesFts();
  step('fts-messages');
  // 同理：transcript FTS（kind 分解索引，roadmap 2.1）
  sessionRepo.backfillTranscriptFts();
  step('fts-transcript');
  // 同理：memories FTS（BM25 检索通道，roadmap 2.5）
  memoryRepo.backfillMemoriesFts();
  step('fts-memories');

  return snapshot;
}
