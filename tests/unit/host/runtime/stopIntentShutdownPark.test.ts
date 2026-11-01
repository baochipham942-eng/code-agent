import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { parkPrimaryRunsOnStopIntentShutdown } from '../../../../src/host/runtime/stopIntentShutdownPark';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { setDaemonQuitIntent } from '../../../../src/host/services/daemon/quitIntent';

// FB-324：stop-intent 停机时主 run 必须落可恢复终态——有原生恢复描述符的停靠成
// waiting+user_stop（重开出现继续提示），没有的落终态 cancelled；非 stop 意图
// （none/background）保持不动（run 留在 registry，交给原有停机路径）。
describe('parkPrimaryRunsOnStopIntentShutdown (FB-324)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    setDaemonQuitIntent('none');
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setDaemonQuitIntent('none');
  });

  function openRegistry(label: string) {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), `stop-intent-park-${label}-`)));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: label,
      leaseDurationMs: 60_000,
    }));
    cleanups.push(() => {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    });
    return { workspace, repository, registry };
  }

  function rawRunRow(repository: DurableRunRepository, runId: string) {
    return (repository as unknown as { db: Database }).db
      .prepare('SELECT status, envelope_json FROM durable_runs WHERE run_id = ?')
      .get(runId) as { status: string; envelope_json: string } | undefined;
  }

  async function checkpointModelOperation(registry: RunRegistry, runId: string) {
    await registry.checkpointNativeModelOperation({
      runId,
      sourceMessageId: `msg-${runId}`,
      provider: 'provider',
      model: 'model',
      logicalOperationId: `turn-${runId}`,
      phase: 'after_model_dispatch',
      status: 'dispatched',
    });
  }

  it('stop intent parks a resumable primary run as waiting + user_stop and frees the handle', async () => {
    const { repository, registry } = openRegistry('park');
    const handle = await registry.startDurable({ sessionId: 'session-park', workspace: '/tmp/ws-park' });
    await checkpointModelOperation(registry, handle.context.runId);
    setDaemonQuitIntent('stop');

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', parked: 1, terminalCancelled: 0, errors: 0 });
    const row = rawRunRow(repository, handle.context.runId);
    expect(row?.status).toBe('waiting');
    expect(row?.envelope_json).toContain('"interruptCause":"user_stop"');
    expect(registry.hasDurableOwner(handle.context.runId)).toBe(true);
    expect(registry.get(handle.context.runId)).toBeUndefined();
  });

  it('stop intent terminally cancels a run without a native recovery descriptor', async () => {
    const { repository, registry } = openRegistry('terminal');
    // 无 checkpointNativeModelOperation —— 没有 native recovery descriptor
    const handle = await registry.startDurable({ sessionId: 'session-terminal', workspace: '/tmp/ws-terminal' });
    setDaemonQuitIntent('stop');

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', parked: 0, terminalCancelled: 1, errors: 0 });
    const row = rawRunRow(repository, handle.context.runId);
    expect(row?.status).toBe('cancelled');
    expect(registry.hasDurableOwner(handle.context.runId)).toBe(false);
  });

  it('non-stop intent (none) leaves every active run untouched', async () => {
    const { registry } = openRegistry('none');
    const handle = await registry.startDurable({ sessionId: 'session-none', workspace: '/tmp/ws-none' });
    await checkpointModelOperation(registry, handle.context.runId);

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'none', parked: 0, terminalCancelled: 0, errors: 0 });
    expect(registry.get(handle.context.runId)).toBe(handle);
    expect(registry.hasDurableOwner(handle.context.runId)).toBe(true);
  });

  it('background intent also leaves active runs untouched (daemon keeps them)', async () => {
    const { registry } = openRegistry('bg');
    const handle = await registry.startDurable({ sessionId: 'session-bg', workspace: '/tmp/ws-bg' });
    await checkpointModelOperation(registry, handle.context.runId);
    setDaemonQuitIntent('background');

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'background', parked: 0, terminalCancelled: 0, errors: 0 });
    expect(registry.get(handle.context.runId)).toBe(handle);
  });
});
