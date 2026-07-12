import { describe, expect, it, vi } from 'vitest';
import { DurableRunReadService } from '../../../../src/host/app/durableRunReadService';
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
});
