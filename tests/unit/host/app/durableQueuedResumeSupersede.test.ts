import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import type { Message } from '../../../../src/shared/contract';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRecoveryDispatcher, type DurableRecoveryDispatchResult } from '../../../../src/host/runtime/durableRecoveryDispatcher';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { shouldStartQueuedAutoResume } from '../../../../src/host/app/durableRunContinuation';

function user(id: string): Message {
  return { id, role: 'user', content: id, timestamp: 1 } as Message;
}

/** 两条崩溃中断的 native run（各自会话），重启后都进自动续跑队列。 */
async function crashTwoRuns() {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-queued-supersede-')));
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernelFor = (processInstanceId: string) => new DurableRunKernel({
    stores: repository, ownerId: 'native-host', processInstanceId, leaseDurationMs: 100,
  });
  const before = new RunRegistry();
  before.configureDurableKernel(kernelFor('before-crash'));
  for (const name of ['a', 'b']) {
    await before.startDurable({ runId: `run-${name}`, sessionId: `session-${name}`, workspace, cwd: workspace }, 1_000);
    await before.checkpointNativeModelOperation({
      runId: `run-${name}`, sourceMessageId: `source-${name}`, provider: 'provider', model: 'model',
      logicalOperationId: `turn-${name}`, phase: 'after_model_dispatch', status: 'dispatched', now: 1_010,
    });
  }
  before.clear();
  const registry = new RunRegistry();
  registry.configureDurableKernel(kernelFor('after-restart'));
  const plans = await registry.recoverDurable(2_000);
  expect(plans.map((plan) => [plan.envelope.runId, plan.envelope.status])).toEqual([['run-a', 'recovering'], ['run-b', 'recovering']]);
  const cleanup = () => {
    registry.clear();
    rmSync(workspace, { recursive: true, force: true });
    db.close();
  };
  return { workspace, repository, registry, plans, cleanup };
}

/**
 * N-RESUME-PARKED-RECLAIM ④（并入 K6-LEFTOVERS①）：自动续跑在后台排队期间用户发新消息，
 * 新消息优先——排队 run 终态化、新一轮正常建 run，出队时不抛错（不再落成 failed / 后台报错）。
 */
describe('queued auto-resume superseded by a new user message', () => {
  it('a new turn during the queue terminalizes the queued run, which then dequeues without throwing', async () => {
    const { workspace, repository, registry, plans, cleanup } = await crashTwoRuns();
    try {
      const messages: Record<string, Message[]> = { 'session-a': [user('source-a')], 'session-b': [user('source-b')] };
      let releaseA!: () => void;
      const recovered: string[] = [];
      const backgroundResults: DurableRecoveryDispatchResult[] = [];
      const backgroundErrors: unknown[] = [];
      const dispatcher = new DurableRecoveryDispatcher({
        beforeAutoResume: (plan) => shouldStartQueuedAutoResume({
          plan, runRegistry: registry, getMessages: async (sessionId) => messages[sessionId],
        }),
        onBackgroundResult: (results) => backgroundResults.push(...results),
        onBackgroundError: (error) => backgroundErrors.push(error),
      });
      dispatcher.registerEngineHandler({
        name: 'native-spy',
        engineKind: 'native',
        serialAutoResume: true,
        recover: async (plan) => {
          recovered.push(plan.envelope.runId);
          // 与生产 TaskManager.resumeExistingDurableRun 同形：源消息之后有新 user 消息就抛。
          if (messages[plan.envelope.sessionId].at(-1)?.id !== `source-${plan.envelope.runId.slice(-1)}`) {
            throw new Error('resume history cannot contain a later user message');
          }
          if (plan.envelope.runId === 'run-a') await new Promise<void>((resolve) => { releaseA = resolve; });
          return { status: 'recovered', reason: 'resume_live_loop' };
        },
      });

      const queued = await dispatcher.dispatch(plans, 2_000);
      expect(queued.map((result) => result.reason)).toEqual(['auto_resume_queued', 'auto_resume_queued']);
      await vi.waitFor(() => expect(recovered).toEqual(['run-a']));

      // run-b 还在排队：协作者在 session-b 发新消息 → 新一轮建 durable run 成功，旧 run 被终态化。
      messages['session-b'].push(user('new-b'));
      // 与 web runAgentTurn / 桌面 sendMessage 建根 run 前同一步。
      await registry.supersedeParkedSessionRoots('session-b', 2_050);
      const next = await registry.startDurable({ runId: 'run-b-new', sessionId: 'session-b', workspace, cwd: workspace }, 2_050);
      expect(next.context.runId).toBe('run-b-new');
      expect(await repository.get('run-b')).toMatchObject({ status: 'cancelled' });

      releaseA();
      await vi.waitFor(() => expect(backgroundResults.map((result) => result.runId)).toContain('run-b'));
      expect(recovered).toEqual(['run-a']);
      expect(backgroundErrors).toEqual([]);
      expect(backgroundResults.filter((result) => result.status === 'failed')).toEqual([]);
      expect(await repository.get('run-b-new')).toMatchObject({ status: 'running' });
      await dispatcher.shutdown();
    } finally {
      cleanup();
    }
  });

  it('dequeue finds a later user message after the source: terminalizes the queued run instead of throwing', async () => {
    const { repository, registry, plans, cleanup } = await crashTwoRuns();
    try {
      const messages: Record<string, Message[]> = {
        'session-a': [user('source-a')],
        'session-b': [user('source-b'), user('new-b')],
      };
      const recovered: string[] = [];
      const backgroundResults: DurableRecoveryDispatchResult[] = [];
      const dispatcher = new DurableRecoveryDispatcher({
        beforeAutoResume: (plan) => shouldStartQueuedAutoResume({
          plan, runRegistry: registry, getMessages: async (sessionId) => messages[sessionId], now: 2_100,
        }),
        onBackgroundResult: (results) => backgroundResults.push(...results),
      });
      dispatcher.registerEngineHandler({
        name: 'native-spy',
        engineKind: 'native',
        serialAutoResume: true,
        recover: async (plan) => {
          recovered.push(plan.envelope.runId);
          if (plan.envelope.runId === 'run-b') throw new Error('resume history cannot contain a later user message');
          return { status: 'recovered', reason: 'resume_live_loop' };
        },
      });

      await dispatcher.dispatch(plans, 2_000);
      await vi.waitFor(() => expect(backgroundResults.map((result) => result.runId)).toEqual(['run-a', 'run-b']));
      expect(recovered).toEqual(['run-a']);
      expect(backgroundResults.map((result) => [result.runId, result.status])).toEqual([['run-a', 'recovered'], ['run-b', 'observing']]);
      expect(await repository.get('run-b')).toMatchObject({
        status: 'cancelled', terminal: { status: 'cancelled', reason: 'superseded_by_new_message' },
      });
      expect(registry.hasDurableOwner('run-b')).toBe(false);
      expect(await repository.get('run-a')).toMatchObject({ status: 'recovering' });
      await dispatcher.shutdown();
    } finally {
      cleanup();
    }
  });
});
