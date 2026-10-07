import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { createCliTables } from '../../../src/cli/cliDatabaseSchema';
import { createCliLedgerSink } from '../../../src/cli/cliLedgerSink';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { computePolicyHash } from '../../../src/host/permissions/policyHash';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { getToolLedgerSink, setToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';
import { recordDecision } from '../../../src/host/tools/toolExecutorDecisionTrace';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const OLD_DECISIONS = `
  CREATE TABLE permission_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    summary TEXT,
    final_outcome TEXT NOT NULL,
    history_outcome TEXT NOT NULL,
    reason TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    trace_json TEXT
  );
`;

function columns(db: Database.Database): string[] {
  return db.prepare('PRAGMA table_info(permission_decisions)').all().map((row) => (row as { name: string }).name);
}

describe('permission_decisions.policy_hash', () => {
  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    resetDecisionHistory();
  });

  afterEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    resetDecisionHistory();
  });

  it('fresh and pre-existing desktop databases gain policy_hash and the repository stores it', () => {
    const fresh = new Database(':memory:');
    try {
      applySchema(fresh, createLogger() as never);
      expect(columns(fresh)).toContain('policy_hash');
      const repo = new PermissionDecisionRepository(fresh);
      repo.append({
        toolName: 'Read', summary: 'README', finalOutcome: 'allow', historyOutcome: 'auto-approve',
        reason: 'read', durationMs: 1, recordedAt: 10, policyHash: 'abc123',
      });
      expect(repo.getRecent()[0]?.policyHash).toBe('abc123');
      repo.append({
        toolName: 'Write', summary: 'a', finalOutcome: 'deny', historyOutcome: 'policy-deny',
        reason: 'no', durationMs: 1, recordedAt: 11,
      });
      expect(repo.getRecent().find((row) => row.toolName === 'Write')?.policyHash).toBeNull();
    } finally {
      fresh.close();
    }

    const preexisting = new Database(':memory:');
    try {
      preexisting.exec(OLD_DECISIONS);
      expect(columns(preexisting)).not.toContain('policy_hash');
      applySchema(preexisting, createLogger() as never);
      expect(columns(preexisting)).toContain('policy_hash');
      const repo = new PermissionDecisionRepository(preexisting);
      repo.append({
        sessionId: 's', toolName: 'Bash', summary: 'echo', finalOutcome: 'ask', historyOutcome: 'ask-denied',
        reason: 'user', durationMs: 2, recordedAt: 20, policyHash: 'from-old-db',
      });
      expect(repo.getBySession('s')[0]?.policyHash).toBe('from-old-db');
    } finally {
      preexisting.close();
    }
  });

  it('recordDecision persists policy_hash through the ledger sink', () => {
    const db = new Database(':memory:');
    const previous = getToolLedgerSink();
    try {
      applySchema(db, createLogger() as never);
      const repo = new PermissionDecisionRepository(db);
      setToolLedgerSink({
        appendPermissionDecision: (input) => repo.append(input),
        appendToolExecutionBegin: () => {},
        appendToolExecutionComplete: () => {},
      });
      getPermissionModeManager().setMode('plan');
      const sessionId = 'ledger-session';
      recordDecision('Bash', { command: 'echo hi' }, 'ask-denied', 'user', 1_000, undefined, sessionId, 'desktop', 5);
      const row = repo.getBySession(sessionId)[0];
      expect(row?.policyHash).toBe(computePolicyHash(sessionId));
      expect(row?.policyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      setToolLedgerSink(previous);
      db.close();
    }
  });

  it('the CLI sink persists policy_hash on a pre-existing CLI database', () => {
    const db = new Database(':memory:');
    try {
      db.exec(OLD_DECISIONS);
      expect(columns(db)).not.toContain('policy_hash');
      createCliTables(db);
      expect(columns(db)).toContain('policy_hash');
      createCliLedgerSink({ getDb: () => db }).appendPermissionDecision({
        sessionId: 'cli', toolName: 'Bash', summary: 'echo', finalOutcome: 'deny',
        historyOutcome: 'policy-deny', reason: 'no', durationMs: 1, recordedAt: 30,
        policyHash: 'cli-hash',
      });
      const row = db.prepare('SELECT policy_hash FROM permission_decisions WHERE session_id = ?').get('cli') as {
        policy_hash: string;
      };
      expect(row.policy_hash).toBe('cli-hash');
    } finally {
      db.close();
    }
  });
});
