import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import type { DecisionTrace } from '../../../src/shared/contract/decisionTrace';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ADR-022 第一期交付证据（确定性形式）：
// "每一次允许/拒绝都留下完整决策流水，且重启不丢。"
describe('事件账本第一期 · 交付证据', () => {
  it('allow + deny 两条决策都留完整流水，且"重启"（新仓储实例读同库）后仍在', () => {
    // 用真实文件库以确保是磁盘持久化（不是内存连接），模拟跨进程重启
    const tmp = path.join(os.tmpdir(), `ledger-evidence-${process.pid}.db`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const db1 = new Database(tmp);
    try {
      applySchema(db1, createLogger() as never);
      const repo1 = new PermissionDecisionRepository(db1);

      const allowTrace: DecisionTrace = {
        toolName: 'Read', finalOutcome: 'allow',
        steps: [{ layer: 'permission_classifier', rule: 'auto-approve', result: 'allow', reason: '只读', durationMs: 1, timestamp: 1 }],
        totalDurationMs: 1,
      };
      const denyTrace: DecisionTrace = {
        toolName: 'bash', finalOutcome: 'deny',
        steps: [{ layer: 'guard_fabric', rule: 'dangerous', result: 'deny', reason: 'rm -rf', durationMs: 2, timestamp: 2 }],
        totalDurationMs: 2,
      };

      repo1.append({ toolName: 'Read', summary: 'README.md', finalOutcome: 'allow', historyOutcome: 'auto-approve', reason: '只读', durationMs: 1, recordedAt: 100, trace: allowTrace });
      repo1.append({ toolName: 'bash', summary: 'rm -rf *', finalOutcome: 'deny', historyOutcome: 'monitor-blocked', reason: 'rm -rf', durationMs: 2, recordedAt: 200, trace: denyTrace });

      expect(repo1.count()).toBe(2);
      db1.close();

      // —— 模拟重启：重新打开同一个磁盘库 + 全新仓储实例 ——
      const db2 = new Database(tmp);
      const repo2 = new PermissionDecisionRepository(db2);
      try {
        expect(repo2.count()).toBe(2); // 重启不丢
        const all = repo2.getRecent();
        const allow = all.find(d => d.finalOutcome === 'allow');
        const deny = all.find(d => d.finalOutcome === 'deny');

        // 允许的那次：完整流水（含 trace 步骤层）
        expect(allow).toMatchObject({ toolName: 'Read', historyOutcome: 'auto-approve' });
        expect(allow?.trace?.steps[0]?.layer).toBe('permission_classifier');

        // 拒绝的那次：完整流水
        expect(deny).toMatchObject({ toolName: 'bash', historyOutcome: 'monitor-blocked' });
        expect(deny?.trace?.steps[0]?.layer).toBe('guard_fabric');
        expect(deny?.trace?.finalOutcome).toBe('deny');
      } finally {
        db2.close();
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });
});
