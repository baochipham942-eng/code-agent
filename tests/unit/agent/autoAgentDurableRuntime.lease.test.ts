import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const loggerState = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: loggerState.warn }),
}));

import { AutoAgentDurableRuntime } from '../../../src/host/agent/autoAgentDurableRuntime';
import type { AgentTeamDurableParentHost } from '../../../src/host/agent/agentTeamDurableTypes';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

function createStack(processInstanceId = 'process-1', leaseDurationMs = 750) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs,
  });
  return { db, repository, kernel };
}

function createParentHost(): AgentTeamDurableParentHost {
  return {
    prepareAgentTeamChild: vi.fn().mockResolvedValue(undefined),
    projectAgentTeamChildTerminal: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AutoAgentDurableRuntime lease ownership', () => {
  beforeEach(() => {
    loggerState.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the auto child lease owned while the graph runs past its original lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { db, repository, kernel } = createStack();
    try {
      const runtime = new AutoAgentDurableRuntime(kernel, createParentHost());
      const controller = await runtime.start({
        parentRunId: 'run-parent',
        sessionId: 'session-auto',
        sourceMessageId: 'message-auto',
        workspace: { root: '/tmp/auto', cwd: '/tmp/auto', fingerprint: 'workspace-fingerprint' },
        graphId: 'auto-agent:session-auto',
        sideEffect: true,
        now: Date.now(),
      });
      const before = await repository.get(controller.runId);
      console.info(`before sweep: run=${controller.runId} attempt=${before?.attempt} epoch=${before?.owner?.epoch} leaseExpiresAt=${before?.owner?.leaseExpiresAt}`);

      await vi.advanceTimersByTimeAsync(751);
      const sweeper = new DurableRunKernel({
        stores: repository,
        ownerId: 'native-host',
        processInstanceId: 'process-sweeper',
        leaseDurationMs: 60_000,
      });
      const recovered = await sweeper.recoverOnStartup(Date.now());
      const after = await repository.get(controller.runId);
      console.info(`after sweep: run=${controller.runId} attempt=${after?.attempt} epoch=${after?.owner?.epoch} recovered=${recovered.length} now=${Date.now()}`);

      await controller.terminal('completed');
      const terminal = await repository.get(controller.runId);
      expect(recovered).toEqual([]);
      expect(terminal).toMatchObject({
        status: 'completed',
        attempt: 1,
        owner: { epoch: 1 },
      });
    } finally {
      db.close();
    }
  });

  it('stops a fenced heartbeat quietly and warns with the run id and reason', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { db, kernel } = createStack();
    try {
      const runtime = new AutoAgentDurableRuntime(kernel, createParentHost());
      const controller = await runtime.start({
        parentRunId: 'run-parent',
        sessionId: 'session-auto',
        sourceMessageId: 'message-auto',
        workspace: { root: '/tmp/auto', cwd: '/tmp/auto', fingerprint: 'workspace-fingerprint' },
        graphId: 'auto-agent:session-auto',
        sideEffect: true,
        now: Date.now(),
      });
      const heartbeat = vi.spyOn(kernel, 'heartbeat').mockImplementation(async (runId) => {
        throw new Error(`Heartbeat fenced by stale owner: ${runId}`);
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(loggerState.warn).toHaveBeenCalledWith('Auto agent durable heartbeat stopped', {
        runId: controller.runId,
        reason: `Heartbeat fenced by stale owner: ${controller.runId}`,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
