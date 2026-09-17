import { describe, expect, it, vi } from 'vitest';
import { SteerRejectedError } from '../../../src/host/agent/runtime/conversationRuntime';
import type { RunHandle } from '../../../src/host/runtime/runContext';
import {
  companionSteerMessagePayload,
  steerOrQueueCompanionMessage,
} from '../../../src/host/services/companion/companionMessageSend';

function fakeRun(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    context: { runId: 'run-live', sessionId: 'session-1' },
    isAttached: true,
    cancellationRequested: false,
    steer: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    ...overrides,
  } as unknown as RunHandle;
}

describe('companion message send while a run is live', () => {
  it('steers into the active run and publishes a plain user message', async () => {
    const run = fakeRun();
    const result = await steerOrQueueCompanionMessage(run, {
      sessionId: 'session-1', commandId: 'cmd-steer', text: '再加一页对比',
    });
    expect(result).toEqual({ runId: 'run-live', outcome: 'steered' });
    expect(run.steer).toHaveBeenCalledWith(
      '再加一页对比',
      'cmd-steer',
      undefined,
      { workbench: { runtimeInputMode: 'supplement' } },
      undefined,
      undefined,
    );
    expect(companionSteerMessagePayload({ commandId: 'cmd-steer', text: '再加一页对比', runId: 'run-live', outcome: 'steered' }))
      .toEqual({ id: 'cmd-steer', role: 'user', content: '再加一页对比', runId: 'run-live' });
  });

  it('queues when steer is rejected and marks the message queued', async () => {
    const run = fakeRun({
      steer: vi.fn(async () => { throw new SteerRejectedError(); }),
    });
    const repository = { enqueue: vi.fn((row: { id: string }) => ({ id: row.id })) };
    const result = await steerOrQueueCompanionMessage(run, {
      sessionId: 'session-1', commandId: 'cmd-queue', text: '这轮做完接着做之前先记下',
    }, repository);
    expect(result).toEqual({ runId: 'run-live', outcome: 'queued' });
    expect(repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cmd-queue',
      sessionId: 'session-1',
      envelope: expect.objectContaining({
        content: '这轮做完接着做之前先记下',
        clientMessageId: 'cmd-queue',
        context: { runtimeInput: { mode: 'supplement' } },
      }),
    }));
    expect(companionSteerMessagePayload({
      commandId: 'cmd-queue', text: '这轮做完接着做之前先记下', runId: 'run-live', outcome: 'queued',
    })).toEqual({
      id: 'cmd-queue', role: 'user', content: '这轮做完接着做之前先记下', runId: 'run-live', queued: true,
    });
  });

  it('queues when the run is no longer attached instead of failing the command', async () => {
    const run = fakeRun({ isAttached: false });
    const repository = { enqueue: vi.fn((row: { id: string }) => ({ id: row.id })) };
    const result = await steerOrQueueCompanionMessage(run, {
      sessionId: 'session-1', commandId: 'cmd-detach', text: '收尾时补一句',
    }, repository);
    expect(result.outcome).toBe('queued');
    expect(run.steer).not.toHaveBeenCalled();
  });
});
