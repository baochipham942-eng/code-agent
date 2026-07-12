import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  DURABLE_RUN_ROLLOUT_ENV,
  readWithDurablePreference,
  resolveDurableRunRollout,
} from '../../../../src/host/app/durableRunRollout';
import { initializeDurableRun } from '../../../../src/host/app/initializeDurableRun';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { applyDurableRunMigrationDraft } from '../../../../src/host/services/core/database/migrations/durableRun';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function repository(): { db: Database.Database; repo: DurableRunRepository } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyDurableRunMigrationDraft(db);
  return { db, repo: new DurableRunRepository(db) };
}

describe('Durable Run rollout policy', () => {
  it('keeps the pre-release default at dual_write and accepts explicit durable_preferred', () => {
    expect(resolveDurableRunRollout({})).toMatchObject({
      mode: 'dual_write',
      valid: true,
      durableActivation: true,
      durableReadPreference: false,
    });
    expect(resolveDurableRunRollout({ [DURABLE_RUN_ROLLOUT_ENV]: 'durable_preferred' })).toMatchObject({
      mode: 'durable_preferred',
      valid: true,
    });
  });

  it.each([
    ['legacy', false, false],
    ['dual_write', true, false],
    ['durable_preferred', true, true],
  ] as const)('resolves %s without a half-enabled state', (mode, activation, reads) => {
    expect(resolveDurableRunRollout({ [DURABLE_RUN_ROLLOUT_ENV]: mode })).toMatchObject({
      mode,
      valid: true,
      durableActivation: activation,
      durableReadPreference: reads,
    });
  });

  it('fails an invalid value closed to legacy with a diagnostic', () => {
    expect(resolveDurableRunRollout({ [DURABLE_RUN_ROLLOUT_ENV]: 'half-on' })).toMatchObject({
      mode: 'legacy',
      valid: false,
      durableActivation: false,
      durableReadPreference: false,
      diagnostic: expect.stringContaining('half-on'),
    });
  });

  it('uses legacy only when a Durable row is proven absent', async () => {
    const policy = resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' });
    const legacy = vi.fn(() => 'legacy-value');
    await expect(readWithDurablePreference({
      policy,
      reader: { getLatestBySession: vi.fn(async () => null) },
      sessionId: 'historical-session',
      readLegacy: legacy,
    })).resolves.toEqual({ source: 'legacy', value: 'legacy-value' });
    expect(legacy).toHaveBeenCalledOnce();
  });

  it('never hides an existing Durable row behind stale legacy state', async () => {
    const { db, repo } = repository();
    const runtime = await initializeDurableRun({
      registry: new RunRegistry(), repository: repo, dataDir: '/tmp', ownerId: 'owner',
      processInstanceId: 'process-1', env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }, leaseDurationMs: 100_000, now: 1,
    });
    await runtime.kernel!.createNativeRun({ runId: 'run-1', sessionId: 'session-1', now: 1 });
    const legacy = vi.fn(() => ({ status: 'completed' }));
    const result = await readWithDurablePreference({
      policy: runtime.policy, reader: repo, sessionId: 'session-1', readLegacy: legacy,
    });
    expect(result).toMatchObject({ source: 'durable', value: { runId: 'run-1', status: 'running' } });
    expect(legacy).not.toHaveBeenCalled();
    await runtime.shutdown();
    db.close();
  });

  it('propagates Durable read failure instead of silently falling back', async () => {
    const legacy = vi.fn();
    await expect(readWithDurablePreference({
      policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }),
      reader: { getLatestBySession: vi.fn(async () => { throw new Error('sqlite unavailable'); }) },
      sessionId: 'session-1',
      readLegacy: legacy,
    })).rejects.toThrow('sqlite unavailable');
    expect(legacy).not.toHaveBeenCalled();
  });
});
