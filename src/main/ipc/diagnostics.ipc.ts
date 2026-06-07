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

        // /permissions — 安全决策历史
        case 'decisions': {
          const { getDecisionHistory } = await import('../security/decisionHistory');
          const history = getDecisionHistory();
          const recent = history.getRecent(10);
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
            },
          };
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
