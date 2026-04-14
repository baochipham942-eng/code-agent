// ============================================================================
// PendingApprovalRepository Tests — ADR-010 #2
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { PendingApprovalRepository } from '../../../src/main/services/core/repositories/PendingApprovalRepository';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      coordinator_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER,
      feedback TEXT
    );
    CREATE INDEX idx_pending_approvals_status ON pending_approvals(status);
    CREATE INDEX idx_pending_approvals_kind_status ON pending_approvals(kind, status);
  `);
}

describe('PendingApprovalRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    repo = new PendingApprovalRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insert', () => {
    it('inserts a plan record with status=pending', () => {
      repo.insert({
        id: 'plan_1',
        kind: 'plan',
        agentId: 'agent_a',
        agentName: 'Agent A',
        coordinatorId: 'coord_1',
        payload: { plan: 'rm -rf /tmp', risk: 'high' },
        submittedAt: 1000,
      });

      const rec = repo.getById('plan_1');
      expect(rec).not.toBeNull();
      expect(rec!.kind).toBe('plan');
      expect(rec!.status).toBe('pending');
      expect(rec!.agentId).toBe('agent_a');
      expect(rec!.coordinatorId).toBe('coord_1');
      expect(rec!.submittedAt).toBe(1000);
      expect(rec!.resolvedAt).toBeNull();
      expect(rec!.feedback).toBeNull();
      const payload = JSON.parse(rec!.payloadJson);
      expect(payload.plan).toBe('rm -rf /tmp');
      expect(payload.risk).toBe('high');
    });

    it('inserts a launch record with null agent fields', () => {
      repo.insert({
        id: 'launch_1',
        kind: 'launch',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: { agentCount: 3, writeAgentCount: 1 },
        submittedAt: 2000,
      });

      const rec = repo.getById('launch_1');
      expect(rec).not.toBeNull();
      expect(rec!.kind).toBe('launch');
      expect(rec!.agentId).toBeNull();
      expect(rec!.agentName).toBeNull();
      expect(rec!.coordinatorId).toBeNull();
    });

    it('falls back to "null" when payload cannot be serialized', () => {
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;

      repo.insert({
        id: 'plan_bad',
        kind: 'plan',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: cyclic,
        submittedAt: 1234,
      });

      const rec = repo.getById('plan_bad');
      expect(rec!.payloadJson).toBe('null');
    });

    it('overwrites an existing row when same id reinserted', () => {
      repo.insert({
        id: 'plan_dup',
        kind: 'plan',
        agentId: 'a',
        agentName: 'A',
        coordinatorId: 'c',
        payload: { v: 1 },
        submittedAt: 100,
      });
      repo.insert({
        id: 'plan_dup',
        kind: 'plan',
        agentId: 'a',
        agentName: 'A',
        coordinatorId: 'c',
        payload: { v: 2 },
        submittedAt: 200,
      });

      const rec = repo.getById('plan_dup');
      expect(JSON.parse(rec!.payloadJson).v).toBe(2);
      expect(rec!.submittedAt).toBe(200);
    });
  });

  describe('resolve', () => {
    beforeEach(() => {
      repo.insert({
        id: 'plan_r',
        kind: 'plan',
        agentId: 'a',
        agentName: 'A',
        coordinatorId: 'c',
        payload: { v: 1 },
        submittedAt: 100,
      });
    });

    it('marks pending row as approved with feedback + resolved_at', () => {
      repo.resolve({
        id: 'plan_r',
        status: 'approved',
        feedback: 'looks good',
        resolvedAt: 500,
      });

      const rec = repo.getById('plan_r');
      expect(rec!.status).toBe('approved');
      expect(rec!.feedback).toBe('looks good');
      expect(rec!.resolvedAt).toBe(500);
    });

    it('marks pending row as rejected', () => {
      repo.resolve({
        id: 'plan_r',
        status: 'rejected',
        feedback: 'too risky',
        resolvedAt: 600,
      });

      const rec = repo.getById('plan_r');
      expect(rec!.status).toBe('rejected');
      expect(rec!.feedback).toBe('too risky');
    });

    it('silently ignores resolve on non-existent id', () => {
      expect(() =>
        repo.resolve({
          id: 'nope',
          status: 'approved',
          feedback: null,
          resolvedAt: 1,
        }),
      ).not.toThrow();
    });

    it('does not re-resolve an already-resolved row', () => {
      repo.resolve({ id: 'plan_r', status: 'approved', feedback: 'first', resolvedAt: 500 });
      repo.resolve({ id: 'plan_r', status: 'rejected', feedback: 'second', resolvedAt: 700 });

      const rec = repo.getById('plan_r');
      expect(rec!.status).toBe('approved');
      expect(rec!.feedback).toBe('first');
      expect(rec!.resolvedAt).toBe(500);
    });
  });

  describe('markAllPendingAsOrphaned', () => {
    it('returns empty array when no pending rows', () => {
      const orphans = repo.markAllPendingAsOrphaned(9999);
      expect(orphans).toEqual([]);
    });

    it('orphans only pending rows, leaves resolved rows alone', () => {
      repo.insert({
        id: 'p1',
        kind: 'plan',
        agentId: 'a1',
        agentName: 'A1',
        coordinatorId: 'c',
        payload: {},
        submittedAt: 100,
      });
      repo.insert({
        id: 'p2',
        kind: 'launch',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: {},
        submittedAt: 200,
      });
      repo.insert({
        id: 'p3_done',
        kind: 'plan',
        agentId: 'a3',
        agentName: 'A3',
        coordinatorId: 'c',
        payload: {},
        submittedAt: 50,
      });
      repo.resolve({ id: 'p3_done', status: 'approved', feedback: 'ok', resolvedAt: 80 });

      const orphans = repo.markAllPendingAsOrphaned(9999);
      expect(orphans).toHaveLength(2);
      expect(orphans.map((o) => o.id).sort()).toEqual(['p1', 'p2']);
      expect(orphans.every((o) => o.status === 'orphaned')).toBe(true);
      expect(orphans.every((o) => o.feedback === 'Orphaned by process restart')).toBe(true);
      expect(orphans.every((o) => o.resolvedAt === 9999)).toBe(true);

      // p3_done untouched
      expect(repo.getById('p3_done')!.status).toBe('approved');
    });

    it('is idempotent on second call', () => {
      repo.insert({
        id: 'p1',
        kind: 'plan',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: {},
        submittedAt: 100,
      });
      repo.markAllPendingAsOrphaned(1000);
      expect(repo.markAllPendingAsOrphaned(2000)).toEqual([]);
      expect(repo.getById('p1')!.resolvedAt).toBe(1000);
    });
  });

  describe('listByKindAndStatus', () => {
    beforeEach(() => {
      repo.insert({ id: 'p1', kind: 'plan', agentId: 'a', agentName: 'A', coordinatorId: 'c', payload: {}, submittedAt: 100 });
      repo.insert({ id: 'p2', kind: 'plan', agentId: 'b', agentName: 'B', coordinatorId: 'c', payload: {}, submittedAt: 300 });
      repo.insert({ id: 'l1', kind: 'launch', agentId: null, agentName: null, coordinatorId: null, payload: {}, submittedAt: 200 });
      repo.resolve({ id: 'p1', status: 'approved', feedback: null, resolvedAt: 150 });
    });

    it('filters by kind + status and orders desc by submitted_at', () => {
      const pendingPlans = repo.listByKindAndStatus('plan', 'pending');
      expect(pendingPlans).toHaveLength(1);
      expect(pendingPlans[0].id).toBe('p2');

      const approvedPlans = repo.listByKindAndStatus('plan', 'approved');
      expect(approvedPlans).toHaveLength(1);
      expect(approvedPlans[0].id).toBe('p1');

      const pendingLaunches = repo.listByKindAndStatus('launch', 'pending');
      expect(pendingLaunches).toHaveLength(1);
      expect(pendingLaunches[0].id).toBe('l1');
    });
  });

  describe('clearAll', () => {
    it('removes all rows', () => {
      repo.insert({ id: 'p1', kind: 'plan', agentId: null, agentName: null, coordinatorId: null, payload: {}, submittedAt: 1 });
      repo.insert({ id: 'p2', kind: 'launch', agentId: null, agentName: null, coordinatorId: null, payload: {}, submittedAt: 2 });

      repo.clearAll();
      expect(repo.getById('p1')).toBeNull();
      expect(repo.getById('p2')).toBeNull();
      expect(repo.listByKindAndStatus('plan', 'pending')).toEqual([]);
    });
  });
});
