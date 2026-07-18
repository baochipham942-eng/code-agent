import { describe, expect, it, vi } from 'vitest';
import {
  DurableRunReadService,
  hasDurableWaitingInputRun,
  projectDurableRunToSessionPayload,
} from '../../../../src/host/app/durableRunReadService';
import { resolveDurableRunRollout } from '../../../../src/host/app/durableRunRollout';

const envelope = {
  schemaVersion: 1 as const, runId: 'durable', sessionId: 'session', engine: { kind: 'native' as const },
  status: 'completed' as const, attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
  terminal: { status: 'completed' as const, eventSeq: 1, at: 2 }, createdAt: 1, updatedAt: 2,
};

describe('DurableRunReadService migrated consumers', () => {
  it('uses the Durable terminal for every migrated consumer', async () => {
    const reader = { getLatestBySession: vi.fn(async () => envelope) };
    const service = new DurableRunReadService(resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }), reader);
    const legacy = vi.fn(() => ({ runId: 'legacy', status: 'running' as const }));
    const views = await Promise.all([
      service.readNativeStatus('session', legacy), service.readNativeControl('session', legacy),
      service.readAgentTeamOrAutoAgent('session', legacy), service.readDynamicWorkflow('session', legacy),
      service.readExternalEngine('session', legacy), service.readSessionReplay('session', legacy),
    ]);
    expect(views.every((view) => view.source === 'durable' && view.terminal && view.status === 'completed')).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('falls back only for a missing row and propagates repository errors', async () => {
    const policy = resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' });
    const missing = new DurableRunReadService(policy, { getLatestBySession: vi.fn(async () => null) });
    await expect(missing.readNativeStatus('historical', () => ({ status: 'idle' }))).resolves.toMatchObject({ source: 'legacy' });
    const failing = new DurableRunReadService(policy, { getLatestBySession: vi.fn(async () => { throw new Error('db failed'); }) });
    await expect(failing.readNativeStatus('session', () => ({ status: 'running' }))).rejects.toThrow('db failed');
  });

  it('derives durable waiting input only from raw durable waiting while keeping the session projection running', async () => {
    const waiting = { ...envelope, status: 'waiting' as const, terminal: undefined };
    const reader = { getLatestBySession: vi.fn(async () => waiting) };
    const service = new DurableRunReadService(resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }), reader);

    const view = await service.readSessionReplay('session', () => ({ status: 'idle' }));
    expect(hasDurableWaitingInputRun(view)).toBe(true);
    expect(projectDurableRunToSessionPayload(view)).toEqual({
      status: 'running',
      durableWaitingInput: true,
    });
  });

  it('does not derive durable waiting input for running or terminal durable rows', async () => {
    const running = {
      ...envelope,
      status: 'running' as const,
      terminal: undefined,
    };
    const terminal = {
      ...envelope,
      status: 'completed' as const,
      terminal: { status: 'completed' as const, eventSeq: 1, at: 2 },
    };

    expect(projectDurableRunToSessionPayload({
      source: 'durable',
      consumer: 'session_replay',
      runId: running.runId,
      sessionId: running.sessionId,
      status: running.status,
      engine: running.engine,
      terminal: false,
    })).toEqual({ status: 'running' });
    expect(projectDurableRunToSessionPayload({
      source: 'durable',
      consumer: 'session_replay',
      runId: terminal.runId,
      sessionId: terminal.sessionId,
      status: terminal.status,
      engine: terminal.engine,
      terminal: true,
    })).toEqual({ status: 'completed' });
  });

  it.each([
    ['failed', 'error'],
    ['completed', 'completed'],
    ['cancelled', 'interrupted'],
  ] as const)('projects durable %s to session %s for list and recovery payloads', (durableStatus, sessionStatus) => {
    for (const consumer of ['session_replay', 'native_status'] as const) {
      expect(projectDurableRunToSessionPayload({
        source: 'durable',
        consumer,
        runId: envelope.runId,
        sessionId: envelope.sessionId,
        status: durableStatus,
        engine: envelope.engine,
        terminal: true,
      })).toEqual({ status: sessionStatus });
    }
  });
});
