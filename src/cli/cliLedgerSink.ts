// ----------------------------------------------------------------------------
// CLI 账本 sink —— 工具/权限账本的 CLI 侧写入口。
// 与桌面同库（code-agent.db），但绝不依赖桌面 databaseService 单例；
// 全程 fail-safe：账本任何失败不得影响 CLI 的权限裁决或工具执行。
// ----------------------------------------------------------------------------

import type { Database } from 'better-sqlite3';
import type { ToolLedgerSink } from '../host/tools/toolLedgerSink';
import type { PermissionDecisionInput } from '../host/services/core/repositories/PermissionDecisionRepository';
import type { ToolExecutionBeginInput, ToolExecutionCompleteInput } from '../host/services/core/repositories/ToolExecutionEventRepository';

interface RawDbProvider {
  getDb(): Database | null;
}

export function createCliLedgerSink(provider: RawDbProvider): ToolLedgerSink {
  return {
    appendPermissionDecision(input: PermissionDecisionInput): void {
      try {
        const db = provider.getDb();
        if (!db) return;
        db.prepare(`
          INSERT INTO permission_decisions
            (session_id, tool_name, summary, final_outcome, history_outcome, reason, duration_ms, wait_ms, origin, recorded_at, trace_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(input.sessionId ?? null, input.toolName, input.summary ?? null, input.finalOutcome,
          input.historyOutcome, input.reason, input.durationMs, input.waitMs ?? null, input.origin ?? null,
          input.recordedAt, input.trace ? JSON.stringify(input.trace) : null);
      } catch {
        // 账本失败不能影响 CLI 的权限裁决。
      }
    },

    appendToolExecutionBegin(input: ToolExecutionBeginInput): void {
      try {
        const db = provider.getDb();
        if (!db) return;
        db.prepare(`
          INSERT INTO tool_execution_events
            (execution_id, session_id, tool_name, summary, params_json, phase, status, error, origin, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'begin', NULL, NULL, ?, ?)
        `).run(input.executionId, input.sessionId ?? null, input.toolName, input.summary ?? null,
          JSON.stringify(input.params ?? {}), input.origin ?? null, input.recordedAt);
      } catch {
        // 账本失败不能影响 CLI 的工具执行。
      }
    },

    appendToolExecutionComplete(input: ToolExecutionCompleteInput): void {
      try {
        const db = provider.getDb();
        if (!db) return;
        db.prepare(`
          INSERT INTO tool_execution_events
            (execution_id, session_id, tool_name, summary, params_json, phase, status, error, origin, recorded_at)
          VALUES (?, ?, ?, ?, NULL, 'complete', ?, ?, ?, ?)
        `).run(input.executionId, input.sessionId ?? null, input.toolName, input.summary ?? null,
          input.status, input.error ?? null, input.origin ?? null, input.recordedAt);
      } catch {
        // 账本失败不能影响 CLI 的工具执行。
      }
    },
  };
}
