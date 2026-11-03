import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 退出意图是进程级单例且无「复位为 none」的公开入口，这里用可控替身，保证每个用例起点确定。
const quitIntent = vi.hoisted(() => ({ value: 'none' as 'none' | 'background' | 'stop' }));
vi.mock('../../../../src/host/services/daemon/quitIntent', () => ({
  getDaemonQuitIntent: () => quitIntent.value,
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { parkPrimaryRunsOnStopIntentShutdown } from '../../../../src/host/runtime/stopIntentShutdownPark';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

// FB-324：stop-intent 停机时主 run 必须落可恢复终态——有原生恢复描述符的停靠成
// waiting+user_stop（重开出现继续提示），没有的落终态 cancelled；非 stop 意图
// （none/background）保持不动（run 留在 registry，交给原有停机路径）。
describe('parkPrimaryRunsOnStopIntentShutdown (FB-324)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    quitIntent.value = 'none';
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    quitIntent.value = 'none';
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
    return (repository as unknown as { db: InstanceType<typeof Database> }).db
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
    quitIntent.value = 'stop';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', parked: 1, terminalCancelled: 0, errors: 0 });
    const row = rawRunRow(repository, handle.context.runId);
    expect(row?.status).toBe('waiting');
    expect(row?.envelope_json).toContain('"interruptCause":"user_stop"');
    // 租约已交出：下次启动立即可认领，不必等租约自然过期
    const lease = (repository as unknown as { db: InstanceType<typeof Database> }).db
      .prepare('SELECT lease_expires_at AS exp FROM durable_runs WHERE run_id = ?')
      .get(handle.context.runId) as { exp: number };
    expect(lease.exp).toBeLessThanOrEqual(Date.now());
    expect(registry.hasDurableOwner(handle.context.runId)).toBe(false);
    expect(registry.get(handle.context.runId)).toBeUndefined();
    expect(await repository.listParkedForReclaim(Date.now(), 10)).toHaveLength(1);
  });

  it('stop intent terminally cancels a run without a native recovery descriptor', async () => {
    const { repository, registry } = openRegistry('terminal');
    // 无 checkpointNativeModelOperation —— 没有 native recovery descriptor
    const handle = await registry.startDurable({ sessionId: 'session-terminal', workspace: '/tmp/ws-terminal' });
    quitIntent.value = 'stop';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', parked: 0, terminalCancelled: 1, errors: 0 });
    const row = rawRunRow(repository, handle.context.runId);
    expect(row?.status).toBe('cancelled');
    expect(registry.hasDurableOwner(handle.context.runId)).toBe(false);
  });

  it('stop intent skips agent-team child runs (no continue entry; parent owns their end state)', async () => {
    const { repository, registry } = openRegistry('child');
    const parent = await registry.startDurable({ sessionId: 'session-child', workspace: '/tmp/ws-child' });
    const child = await registry.startAuxiliaryDurableChild({
      runId: 'run-child-aux', sessionId: 'session-child', workspace: '/tmp/ws-child', cwd: '/tmp/ws-child',
    }, parent.context.runId);
    await checkpointModelOperation(registry, child.context.runId);
    quitIntent.value = 'stop';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', skipped: 1, errors: 0 });
    expect(rawRunRow(repository, child.context.runId)?.status).not.toBe('waiting');
    expect(registry.hasDurableOwner(child.context.runId)).toBe(true);
    expect(registry.get(child.context.runId)).toBe(child);
  });

  it('stop intent leaves external CLI runs to their own lifecycle', async () => {
    const { repository, registry } = openRegistry('ext');
    const { handle: ext } = await registry.startExternalDurable({
      runId: 'run-ext', sessionId: 'session-ext', workspace: '/tmp/ws-ext', cwd: '/tmp/ws-ext', engine: 'codex_cli',
    });
    quitIntent.value = 'stop';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', skipped: 1, terminalCancelled: 0, errors: 0 });
    expect(rawRunRow(repository, ext.context.runId)?.status).not.toBe('cancelled');
    expect(registry.get(ext.context.runId)).toBe(ext);
  });

  it('stop intent ignores handles without a durable owner without logging a false error', async () => {
    const { registry } = openRegistry('noowner');
    const aux = registry.startAuxiliary({ runId: 'run-noowner', sessionId: 'session-noowner', workspace: '/tmp/ws-noowner' });
    quitIntent.value = 'stop';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'stop', parked: 0, terminalCancelled: 0, skipped: 1, errors: 0 });
    expect(registry.get(aux.context.runId)).toBe(aux);
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
    quitIntent.value = 'background';

    const summary = await parkPrimaryRunsOnStopIntentShutdown(registry);

    expect(summary).toMatchObject({ intent: 'background', parked: 0, terminalCancelled: 0, errors: 0 });
    expect(registry.get(handle.context.runId)).toBe(handle);
  });
});
