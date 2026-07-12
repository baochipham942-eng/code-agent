import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  DurableRunRolloutInitializationError,
  initializeDurableRun,
} from '../../../../src/host/app/initializeDurableRun';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { applyDurableRunMigrationDraft } from '../../../../src/host/services/core/database/migrations/durableRun';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function repository(): { db: Database.Database; repo: DurableRunRepository } {
  const db = new Database(':memory:');
  applyDurableRunMigrationDraft(db);
  return { db, repo: new DurableRunRepository(db) };
}

describe('shared Durable Run application initialization', () => {
  it('fails closed when migration or repository initialization is unavailable', async () => {
    await expect(initializeDurableRun({
      registry: new RunRegistry(), repository: null, dataDir: '/tmp', ownerId: 'owner',
      processInstanceId: 'process', env: {},
    })).rejects.toBeInstanceOf(DurableRunRolloutInitializationError);
  });

  it('supports durable_preferred -> legacy -> durable_preferred across restarts without deleting history', async () => {
    const { db, repo } = repository();
    const first = await initializeDurableRun({
      registry: new RunRegistry(), repository: repo, dataDir: '/tmp', ownerId: 'owner',
      processInstanceId: 'process-1', env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }, leaseDurationMs: 100_000, now: 1,
    });
    await first.kernel!.createNativeRun({ runId: 'roundtrip-run', sessionId: 'roundtrip-session', now: 1 });
    await first.shutdown();

    const rollback = await initializeDurableRun({
      registry: new RunRegistry(), repository: null, dataDir: '/tmp', ownerId: 'owner',
      processInstanceId: 'process-2', env: { CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }, now: 2,
    });
    expect(rollback).toMatchObject({ policy: { mode: 'legacy' }, kernel: null, recoveryRuntime: null });
    expect(await repo.get('roundtrip-run')).toMatchObject({ runId: 'roundtrip-run' });
    await rollback.shutdown();

    const restored = await initializeDurableRun({
      registry: new RunRegistry(), repository: repo, dataDir: '/tmp', ownerId: 'owner',
      processInstanceId: 'process-3', env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }, leaseDurationMs: 100_000, now: 3,
    });
    expect(restored.policy.mode).toBe('durable_preferred');
    expect(await repo.get('roundtrip-run')).toMatchObject({ runId: 'roundtrip-run' });
    await restored.shutdown();
    db.close();
  });

  it('keeps Web and Tauri bootstrap on the same rollout initializer', () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const web = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const desktop = readFileSync(path.join(root, 'src/host/app/bootstrap.ts'), 'utf8');
    expect(web).toContain("from '../host/app/initializeDurableRun'");
    expect(desktop).toContain("from './initializeDurableRun'");
    expect(web).toContain('await initializeDurableRun({');
    expect(desktop).toContain('await initializeDurableRun({');
  });
});
