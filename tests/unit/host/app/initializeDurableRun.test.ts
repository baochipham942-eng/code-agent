import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  assembleDurableRun,
  DurableRunRolloutInitializationError,
  initializeDurableRun,
} from '../../../../src/host/app/initializeDurableRun';
import {
  configureBackgroundSubagentDurableLedger,
  getBackgroundSubagentDurableLedger,
  isBackgroundSubagentDurableArmed,
} from '../../../../src/host/agent/backgroundSubagentDurableLedger';
import { BackgroundSubagentRegistry } from '../../../../src/host/agent/backgroundSubagentRegistry';
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

  it('installs the kernel before interrupted-run recovery begins', async () => {
    const { db, repo } = repository();
    const registry = new RunRegistry();
    const assembly = assembleDurableRun({
      registry,
      repository: repo,
      ownerId: 'owner',
      processInstanceId: 'process',
      env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' },
    });

    expect(assembly.kernel).not.toBeNull();
    await expect(registry.waitForDurableKernel(1)).resolves.toBe(true);

    const runtime = await assembly.recover({ dataDir: '/tmp', now: 1 });
    await runtime.shutdown();
    db.close();
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

  it('keeps the shipped Web bootstrap on the shared rollout assembly', () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const web = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    expect(web).toContain("from '../host/app/initializeDurableRun'");
    expect(web).toContain('assemble: () => assembleDurableRun({');
    expect(web).toContain('recover: (assembly) => assembly.recover({');
  });

  it('rolls back armed state when kernel wiring fails, so later background spawn falls back to in-memory (ai-review 2026-09-14)', async () => {
    configureBackgroundSubagentDurableLedger.resetForTest();
    const { db, repo } = repository();
    const registry = new RunRegistry();
    vi.spyOn(registry, 'configureDurableKernel').mockImplementation(() => {
      throw new Error('simulated durable kernel wiring failure');
    });

    expect(() => assembleDurableRun({
      registry, repository: repo, ownerId: 'owner', processInstanceId: 'process',
      env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' },
    })).toThrow(DurableRunRolloutInitializationError);

    // armed 不许残留：残留会让后台 spawn 死等一个永远不会 configure 的账本（30s 超时）。
    expect(isBackgroundSubagentDurableArmed()).toBe(false);
    expect(getBackgroundSubagentDurableLedger()).toBeNull();

    // 进程此时实为 legacy：后台 spawn 必须纯内存跑通（真定时器，不等 BOOTSTRAP 超时）。
    const spawned = new BackgroundSubagentRegistry();
    const agentId = spawned.spawn(
      async () => ({ success: true, output: 'in-memory ok', toolsUsed: [], iterations: 1 }),
      { sessionId: 'session-after-init-failure', runId: 'run-after-init-failure' },
    );
    const result = await spawned.await(agentId);
    expect(result?.output).toBe('in-memory ok');
    expect(spawned.getStatus(agentId)?.status).toBe('completed');
    expect(await repo.get(agentId)).toBeNull();

    db.close();
    configureBackgroundSubagentDurableLedger.resetForTest();
  });
});
