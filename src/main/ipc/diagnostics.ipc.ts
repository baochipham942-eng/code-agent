// ============================================================================
// Diagnostics IPC Handlers — 把 main 进程的诊断单例数据暴露给 GUI 命令
//
// 背景：/context /cost /permissions 这些 slash 命令的部分数据来自 main 进程单例
// （exec policy / decision history / budget / autocompressor stats），renderer
// 进程拿不到（直接 import main 模块会单例失效）。这里通过 domain handler 暴露，
// 让 renderer 侧命令实现走 invokeDomain 取真实数据，而不是 import main。
//
// 这些单例都不依赖 per-session agent 实例，命令执行（用户主动查询，通常无 active
// agent loop）时也能正常返回。
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { SWARM_TRACE } from '../../shared/constants/storage';

export function registerDiagnosticsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.DIAGNOSTICS, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      switch (action) {
        // /permissions — exec policy 规则
        case 'execPolicy': {
          const { getExecPolicyStore } = await import('../security/execPolicy');
          const rules = getExecPolicyStore().getRules();
          return {
            success: true,
            data: {
              rules: rules.map(r => ({
                pattern: r.pattern,
                decision: r.decision,
                createdAt: r.createdAt,
                source: r.source,
              })),
            },
          };
        }

        // /permissions — 安全决策历史（内存环形缓冲 + 持久化事件账本 ADR-022 第一期）
        case 'decisions': {
          const { getDecisionHistory } = await import('../security/decisionHistory');
          const history = getDecisionHistory();
          const recent = history.getRecent(10);

          // 持久化账本（跨重启）：fail-safe，db 未就绪时返回空，不影响内存数据
          let persistedTotal = 0;
          let persistedRecent: Array<Record<string, unknown>> = [];
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const db = getDatabase();
            persistedTotal = db.countPermissionDecisions();
            persistedRecent = db.getRecentPermissionDecisions(10).map(d => ({
              recordedAt: d.recordedAt,
              toolName: d.toolName,
              summary: d.summary,
              finalOutcome: d.finalOutcome,
              historyOutcome: d.historyOutcome,
              reason: d.reason,
              durationMs: d.durationMs,
              traceSteps: d.trace?.steps.length ?? 0,
            }));
          } catch {
            // 静默：账本读取失败不影响内存历史返回
          }

          return {
            success: true,
            data: {
              total: history.getAll().length,
              recent: recent.map(e => ({
                timestamp: e.timestamp,
                toolName: e.toolName,
                summary: e.summary,
                outcome: e.outcome,
                reason: e.reason,
                durationMs: e.durationMs,
                traceOutcome: e.decisionTrace?.finalOutcome,
                traceSteps: e.decisionTrace?.steps.length,
              })),
              // 新增：持久化账本视图（重启不丢；第一期交付证据）
              persistedTotal,
              persistedRecent,
            },
          };
        }

        // /permissions — 崩溃重放现场（ADR-022 第二期交付证据）：启动时从总账重建出的
        // "崩溃前正在做的事"（在飞工具+完整参数+归属 session），取代"只翻 interrupted 标记"。
        case 'recovery': {
          let recoveredAt = 0;
          let totalInFlight = 0;
          let sessions: Array<Record<string, unknown>> = [];
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const snapshot = getDatabase().getLastRecoverySnapshot();
            if (snapshot) {
              recoveredAt = snapshot.recoveredAt;
              totalInFlight = snapshot.totalInFlight;
              sessions = snapshot.sessions.map(s => ({
                sessionId: s.sessionId,
                operations: s.operations.map(op => ({
                  executionId: op.executionId,
                  toolName: op.toolName,
                  summary: op.summary,
                  params: op.params,
                  startedAt: op.startedAt,
                  elapsedMs: op.elapsedMs,
                })),
              }));
            }
          } catch {
            // 静默：恢复快照读取失败不影响出口返回（fail-safe）
          }
          return {
            success: true,
            data: { recoveredAt, totalInFlight, sessions },
          };
        }

        // /permissions（复盘）— 一本账会话复盘（ADR-022 第三期 3a 交付证据）：把一个会话的
        // 对话+任务+协同+成本+决策+执行，按时间合并成统一时间线读出（纯只读投影，ADR-023 P2）。
        case 'sessionLedger': {
          const payload = (request.payload ?? {}) as { sessionId?: string; limit?: number };
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_ACTION', message: 'sessionLedger requires payload.sessionId' },
            };
          }
          const emptyCounts = { message: 0, task: 0, swarm: 0, decision: 0, execution: 0 };
          const emptyCost = { estimatedCost: 0, tokensIn: 0, tokensOut: 0 };
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const ledger = getDatabase().getSessionLedger(sessionId);
            const limit = payload.limit;
            const entries = typeof limit === 'number' && limit > 0 ? ledger.entries.slice(-limit) : ledger.entries;
            return {
              success: true,
              data: {
                sessionId: ledger.sessionId,
                generatedAt: ledger.generatedAt,
                cost: ledger.cost,
                laneCounts: ledger.laneCounts,
                entries,
              },
            };
          } catch {
            // 静默 fail-safe：读账失败返回空账结构，不影响出口
            return {
              success: true,
              data: { sessionId, generatedAt: 0, cost: emptyCost, laneCounts: emptyCounts, entries: [] },
            };
          }
        }

        // /permissions（复盘）— Swarm 影子对账（ADR-022 第三期 3b · ADR-023 D2 交付证据）：
        // 比对"从 append-only 协同账本重建的 rollup"与"现存 rollup 表"，drift 为空=账本可当真理源。
        case 'swarmReconcile': {
          const payload = (request.payload ?? {}) as { runId?: string };
          const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
          if (!runId) {
            return {
              success: false,
              error: { code: 'INVALID_ACTION', message: 'swarmReconcile requires payload.runId' },
            };
          }
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const result = getDatabase().reconcileSwarmRun(runId);
            return { success: true, data: result };
          } catch {
            return { success: true, data: { runId, match: false, drift: [], note: 'reconcile-error' } };
          }
        }

        // 第四期：批量对账扫描出口（按需拉演示证据）。纯只读、fail-safe。
        case 'swarmReconcileScan': {
          const payload = (request.payload ?? {}) as { limit?: number };
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const { runReconcileScan, createDatabaseReconcileReader } = await import('../services/core/swarmReconcileService');
            const report = runReconcileScan(createDatabaseReconcileReader(getDatabase()), {
              now: Date.now(),
              limit: payload.limit,
            });
            return { success: true, data: report };
          } catch {
            return {
              success: true,
              data: { generatedAt: 0, scannedCount: 0, matched: 0, drifted: [], skipped: [], errors: [], coverageNote: 'reconcile-scan-error' },
            };
          }
        }

        // 第四期：opt-in 老库迁移（B1 默认跳过；仅手动触发此出口才反向 backfill ledger）。fail-safe。
        case 'swarmLedgerBackfill': {
          try {
            const { getDatabase } = await import('../services/core/databaseService');
            const { backfillSwarmLedger } = await import('../services/core/database/backfillSwarmLedger');
            const { SwarmLedgerRepository } = await import('../services/core/repositories/SwarmLedgerRepository');
            const db = getDatabase();
            const rawDb = db.getDb();
            if (!rawDb) {
              return { success: true, data: { backfilled: [], skipped: [], errors: [{ runId: '*', error: 'db-unavailable' }] } };
            }
            const trace = db.getSwarmTraceRepo();
            const ledger = new SwarmLedgerRepository(rawDb);
            const result = backfillSwarmLedger({
              listRunIds: () => trace.listRuns(SWARM_TRACE.MAX_LIST_LIMIT).map((r) => r.id),
              getStoredRunDetail: (id) => trace.getRunDetail(id),
              hasLedger: (id) => ledger.getByRun(id).length > 0,
              appendLedger: (input) => ledger.append(input),
              transaction: (fn) => rawDb.transaction(fn)(),
              now: Date.now(),
            });
            return { success: true, data: result };
          } catch {
            return { success: true, data: { backfilled: [], skipped: [], errors: [{ runId: '*', error: 'backfill-error' }] } };
          }
        }

        // renderer 错误落盘：把 renderer 侧错误（如更新安装失败）写进后端 file logger
        // （code-agent-*.log）。修复"renderer logger 只走 console、正式包 devtools 关、
        // 失败无据可查"的可观测性缺口——renderer 在 catch 里 fire-and-forget 调本出口即留痕。
        case 'logClientError': {
          const payload = (request.payload ?? {}) as {
            context?: string;
            message?: string;
            detail?: string;
          };
          const message = typeof payload.message === 'string' ? payload.message.trim() : '';
          if (!message) {
            return {
              success: false,
              error: { code: 'INVALID_ACTION', message: 'logClientError requires payload.message' },
            };
          }
          const context =
            typeof payload.context === 'string' && payload.context.trim()
              ? payload.context.trim()
              : 'ClientError';
          const { createLogger } = await import('../services/infra/logger');
          createLogger(context).error(
            message,
            typeof payload.detail === 'string' && payload.detail ? { detail: payload.detail } : undefined,
          );
          return { success: true, data: { logged: true } };
        }

        // /cost — 预算状态
        case 'budget': {
          const { getBudgetService } = await import('../services/core/budgetService');
          const status = getBudgetService().checkBudget();
          return {
            success: true,
            data: {
              currentCost: status.currentCost,
              maxBudget: status.maxBudget,
              usagePercentage: status.usagePercentage,
            },
          };
        }

        // /context — 上下文压缩统计
        case 'compression': {
          const { getAutoCompressor } = await import('../context/autoCompressor');
          const stats = getAutoCompressor().getStats();
          return {
            success: true,
            data: {
              compressionCount: stats.compressionCount,
              totalSavedTokens: stats.totalSavedTokens,
            },
          };
        }

        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown diagnostics action: ${action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
