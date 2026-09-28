import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { createApplicationNativeRecoveryPorts } from '../../../../src/host/app/nativeRecoveryHost';
import {
  NativeRecoveryHost,
  type NativeRecoveryDescriptor,
} from '../../../../src/host/runtime/nativeRecoveryHost';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import type { Message } from '../../../../src/shared/contract';
import type { PendingOperation } from '../../../../src/shared/contract/durableRun';

function createRepository() {
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  return { db, repository };
}

function kernel(repository: DurableRunRepository, processInstanceId: string) {
  return new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs: 100,
  });
}

async function attachLiveLoopReplacement(
  registry: RunRegistry,
  runId: string,
  descriptor: NativeRecoveryDescriptor,
  now: number,
): Promise<PendingOperation> {
  const envelope = registry.getDurableEnvelope(runId);
  if (!envelope) throw new Error(`durable envelope missing for ${runId}`);
  const replacement: PendingOperation = {
    runId,
    operationId: 'model:live-loop-turn',
    attempt: envelope.attempt,
    kind: 'model_call',
    status: 'dispatched',
    idempotencyKey: 'idem-live-loop-turn',
    sideEffect: false,
    preparedAt: now,
    updatedAt: now,
  };
  await registry.checkpointDurable(runId, {
    now,
    status: 'running',
    state: {
      ...descriptor,
      operationId: replacement.operationId,
      logicalOperationId: 'live-loop-turn',
      phase: 'after_model_dispatch',
      checkpointSequence: envelope.cursor.checkpointSeq + 1,
    },
    engineCursor: {
      schemaVersion: 1,
      runtime: 'native',
      operationId: replacement.operationId,
      phase: 'after_model_dispatch',
    },
    pendingOperations: [...(envelope.pendingOperations ?? []), replacement],
    childRuns: envelope.childRuns,
    events: [{
      type: 'native_live_loop_replacement_op',
      payload: { operationId: replacement.operationId },
      recordedAt: now,
    }],
  });
  return replacement;
}

describe('native recovery after a second crash during the resumed live loop', () => {
  it('settles the fenced model op and resumes the replacement instead of parking for review', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-recrash-')));
    const { db, repository } = createRepository();
    const firstRegistry = new RunRegistry();
    firstRegistry.configureDurableKernel(kernel(repository, 'process-before-crash'));
    const afterFirstCrash = new RunRegistry();
    afterFirstCrash.configureDurableKernel(kernel(repository, 'process-after-first-crash'));
    const afterSecondCrash = new RunRegistry();
    afterSecondCrash.configureDurableKernel(kernel(repository, 'process-after-second-crash'));

    let messages: Message[] = [{
      id: 'prepared-source-message',
      role: 'user',
      content: '恢复这次模型调用',
      timestamp: 1_005,
    }];
    let liveLoopStarts = 0;
    let activeRegistry = afterFirstCrash;
    const resumeExistingDurableRun = vi.fn(async () => {
      liveLoopStarts += 1;
      if (liveLoopStarts === 1) {
        const envelope = activeRegistry.getDurableEnvelope('run-repeated-crash');
        const descriptor = (await repository.getLatest('run-repeated-crash'))?.state as NativeRecoveryDescriptor;
        expect(envelope?.pendingOperations).toEqual(expect.arrayContaining([
          expect.objectContaining({
            operationId: 'model:prepared-turn',
            status: 'abandoned',
            resultRef: 'model-recovery:superseded-by-live-loop:model:prepared-turn',
          }),
        ]));
        await attachLiveLoopReplacement(activeRegistry, 'run-repeated-crash', descriptor, 2_050);
        throw new Error('simulated kill -9 during resumed stream');
      }
      messages = [...messages, {
        id: 'prepared-recovered-result',
        role: 'assistant',
        content: '第二次恢复续跑完成',
        timestamp: 3_001,
      }];
    });

    try {
      const original = await firstRegistry.startDurable({
        runId: 'run-repeated-crash',
        sessionId: 'session-repeated-crash',
        workspace,
        cwd: workspace,
      }, 1_000);
      await firstRegistry.checkpointNativeModelOperation({
        runId: original.context.runId,
        sourceMessageId: 'prepared-source-message',
        provider: 'openai',
        model: 'gpt-test',
        logicalOperationId: 'prepared-turn',
        phase: 'before_model_dispatch',
        status: 'prepared',
        now: 1_010,
      });
      firstRegistry.clear();

      const [firstPlan] = await afterFirstCrash.recoverDurable(2_000);
      const firstPorts = createApplicationNativeRecoveryPorts(afterFirstCrash, {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage: vi.fn(async (messageId: string, updates: Partial<Message>) => {
            messages = messages.map((message) => message.id === messageId
              ? { ...message, ...updates }
              : message);
          }),
        },
        tasks: { resumeExistingDurableRun },
        now: () => 2_000,
      });
      await expect(new NativeRecoveryHost(afterFirstCrash, firstPorts).createHandler().recover(firstPlan, 2_000))
        .rejects.toThrow('simulated kill -9 during resumed stream');
      afterFirstCrash.clear();

      const pendingAfterFirstResume = await repository.listPendingOperations(original.context.runId);
      expect(pendingAfterFirstResume).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operationId: 'model:prepared-turn',
          status: 'abandoned',
          resultRef: 'model-recovery:superseded-by-live-loop:model:prepared-turn',
        }),
        expect.objectContaining({
          operationId: 'model:live-loop-turn',
          status: 'dispatched',
        }),
      ]));

      activeRegistry = afterSecondCrash;
      const [secondPlan] = await afterSecondCrash.recoverDurable(Date.now() + 60_000);
      const secondPorts = createApplicationNativeRecoveryPorts(afterSecondCrash, {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage: vi.fn(async (messageId: string, updates: Partial<Message>) => {
            messages = messages.map((message) => message.id === messageId
              ? { ...message, ...updates }
              : message);
          }),
        },
        tasks: { resumeExistingDurableRun },
        now: () => 3_000,
      });
      await expect(new NativeRecoveryHost(afterSecondCrash, secondPorts).createHandler().recover(secondPlan, 3_000))
        .resolves.toMatchObject({
          status: 'recovered',
          reason: 'resume_live_loop',
        });
      expect(liveLoopStarts).toBe(2);
      expect(resumeExistingDurableRun).toHaveBeenCalledTimes(2);
      expect(await repository.get(original.context.runId)).toMatchObject({
        status: 'running',
        runId: original.context.runId,
      });
    } finally {
      firstRegistry.clear();
      afterFirstCrash.clear();
      afterSecondCrash.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
