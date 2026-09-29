// ============================================================================
// 启动期 DB 维护
// ============================================================================
// 顺序执行：崩溃会话标记 → 工具执行账本恢复 → 消息层孤儿清算 → ledger health → FTS backfill。
// 都在启动关键路径上，耗时由调用方的 step 计时器记录。

import type { Database } from 'better-sqlite3';
import { buildRecoverySnapshot, acknowledgeRecovery, type RecoverySnapshot } from '../crashRecovery';
import { checkLedgerHealth } from './ledgerHealthCheck';
import type { SessionRepository } from '../repositories/SessionRepository';
import type { MemoryRepository } from '../repositories/MemoryRepository';
import type { ToolExecutionEventRepository } from '../repositories/ToolExecutionEventRepository';
import type { PermissionDecisionRepository } from '../repositories/PermissionDecisionRepository';
import type { createLogger } from '../../infra/logger';
import {
  persistCancelledToolCallClosures,
  INTERRUPTED_TOOL_CALL_PLACEHOLDER,
  INTERRUPTED_TOOL_CALL_PLACEHOLDER_NOT_STARTED,
  type CrashRecoveryTier,
} from '../../../agent/runtime/cancelledToolCallClosure';
import { backfillTelemetrySessionTitles } from '../../../telemetry/telemetrySessionTitleBackfill';
import { repairCorruptFtsOnStartup } from './ftsRepair';
import { runGatedProjectionCheck } from './projectionCheckGate';

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
  db: Database;
  sessionRepo: SessionRepository;
  memoryRepo: MemoryRepository;
  toolExecutionEventRepo: ToolExecutionEventRepository;
  permissionDecisionRepo: PermissionDecisionRepository;
  logger: Logger;
  /** 分步计时回调（databaseService 的 init timings 日志） */
  step: (name: string) => void;
  /** applySchema 之前读到的投影 DDL 签名（readProjectionSchemaBeforeBoot）；null = 没读到，按变化处理 */
  projectionSchemaBeforeBoot?: string | null;
  /** 库经过备份恢复/完整性降级：投影一律完整核对 */
  forceFullProjectionCheck?: boolean;
}

/** 返回崩溃恢复快照（fail-safe：扫描失败返回 null，不阻塞启动） */
export function runStartupMaintenance(deps: StartupMaintenanceDeps): RecoverySnapshot | null {
  const { db, sessionRepo, memoryRepo, toolExecutionEventRepo, permissionDecisionRepo, logger, step } = deps;

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
      // Stored-automatic operations stay open until the application continuation
      // rechecks the current declaration and either replays or interrupts them.
      acknowledgeRecovery(
        toolExecutionEventRepo,
        snapshot,
        Date.now(),
        (operation) => operation.replaySafety !== 'automatic',
      );
    }
  } catch (err) {
    logger.warn('[DatabaseService] Crash recovery scan failed (ignored):', err);
  }
  step('crash-recovery');

  for (const sessionId of crashedSessions.sessionIds) {
    try {
      const messages = sessionRepo.getMessages(sessionId);
      const storedAutomaticToolCallIds = new Set(
        snapshot?.sessions
          .find((session) => session.sessionId === sessionId)
          ?.operations
          .filter((operation) => operation.replaySafety === 'automatic' && operation.toolCallId)
          .map((operation) => operation.toolCallId as string) ?? [],
      );
      for (const assistantMessage of messages) {
        if (assistantMessage.role !== 'assistant' || !assistantMessage.toolCalls?.length) continue;
        const toolCallsToInterrupt = assistantMessage.toolCalls.filter(
          (toolCall) => !storedAutomaticToolCallIds.has(toolCall.id),
        );
        if (toolCallsToInterrupt.length === 0) continue;
        persistCancelledToolCallClosures({
          messages,
          assistantMessage,
          toolCalls: toolCallsToInterrupt,
          placeholder: INTERRUPTED_TOOL_CALL_PLACEHOLDER,
          // N-CRASH-OUTCOME-TIERS：按账本是否留有 begin 事件把清算结果分成两档——
          // NOT_STARTED（从未开始，可安全重发）/ OUTCOME_UNKNOWN（可能跑过，先核对外部状态）。
          // 账本查不动时一律按 OUTCOME_UNKNOWN 兜底，宁可存疑绝不凭疑问宣称「没跑过」。
          resolveClosure: (toolCall) => {
            let tier: CrashRecoveryTier = 'OUTCOME_UNKNOWN';
            try {
              if (!toolExecutionEventRepo.hasBeginForToolCall(sessionId, toolCall.id)) {
                tier = 'NOT_STARTED';
              }
            } catch (err) {
              logger.warn(
                `[DatabaseService] Crash tier lookup failed for session ${sessionId} tool call ${toolCall.id} (fail-safe OUTCOME_UNKNOWN):`,
                err,
              );
            }
            return {
              error: tier === 'NOT_STARTED'
                ? INTERRUPTED_TOOL_CALL_PLACEHOLDER_NOT_STARTED
                : INTERRUPTED_TOOL_CALL_PLACEHOLDER,
              metadata: { crashRecoveryTier: tier },
            };
          },
          messageIdSuffix: 'interrupted-tool-results',
          persistMessage: (message) => {
            sessionRepo.addMessage(sessionId, message, { provenanceKind: 'crash-recovery' });
            messages.push(message);
          },
        });
      }
    } catch (err) {
      logger.warn(
        `[DatabaseService] Orphan tool-call closure failed for crashed session ${sessionId} (ignored):`,
        err,
      );
    }
  }
  step('orphan-toolcall-closure');

  checkLedgerHealth(
    { db, toolExecutionEventRepo, permissionDecisionRepo, warn: (msg, data) => logger.warn(msg, data) },
    Date.now(),
  );
  step('ledger-health');

  const ftsRepaired = repairCorruptFtsOnStartup(db);
  step('fts-repair');

  // 投影对账（source 计数 vs FTS 计数，不一致才重建）按需执行：指纹未变就跳过全表计数，
  // 见 projectionCheckGate.ts 顶部的跳过条件与兜底。
  const gateInput = {
    force: ftsRepaired || deps.forceFullProjectionCheck === true,
    signatureBeforeSchema: deps.projectionSchemaBeforeBoot ?? null,
    now: Date.now(),
  };
  runGatedProjectionCheck(db, 'session_messages_fts', gateInput, (onVerified) => {
    sessionRepo.backfillSessionMessagesFts({ onVerified });
  });
  step('fts-messages');
  // 同理：transcript FTS（kind 分解索引，roadmap 2.1）
  runGatedProjectionCheck(db, 'transcript_fts', gateInput, (onVerified) => {
    sessionRepo.backfillTranscriptFts({ onVerified });
  });
  step('fts-transcript');
  // 同理：memories FTS（BM25 检索通道，roadmap 2.5）
  memoryRepo.backfillMemoriesFts();
  step('fts-memories');

  // N-TELEMETRY-SESSION-TITLE-STALE：遥测标题历史只存开会话那刻的占位快照，
  // 用 sessions.title 幂等回填（在线同步之外的写路径由这里兜底收敛）。
  backfillTelemetrySessionTitles(db);
  step('telemetry-title-backfill');

  return snapshot;
}
