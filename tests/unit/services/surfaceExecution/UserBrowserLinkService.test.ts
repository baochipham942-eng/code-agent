import { describe, expect, it, vi } from 'vitest';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { UserBrowserLinkService } from '../../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import type { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import type { SurfaceConversationSnapshotV1 } from '../../../../src/shared/contract/surfaceExecution';

function snapshot(conversationId: string): SurfaceConversationSnapshotV1 {
  return {
    version: 1,
    conversationId,
    sessions: [],
    updatedAt: 1,
  };
}

function createHarness(success = true) {
  const registry = new RunRegistry();
  const endRun = vi.fn(async () => undefined);
  const runtime = {
    endRun,
    snapshotConversation: vi.fn((conversationId: string) => snapshot(conversationId)),
  };
  const execute = vi.fn(async () => success
    ? { success: true, metadata: { surfaceSessionId: 'surface-user-1' } }
    : { success: false, error: 'navigation failed' });
  const service = new UserBrowserLinkService(
    registry,
    runtime,
    { execute } as Pick<ManagedBrowserProviderAdapter, 'execute'>,
  );
  return { registry, runtime, execute, endRun, service };
}

describe('UserBrowserLinkService', () => {
  it('keeps a lightweight user run alive until a normal rail terminal and preserves the agent run', async () => {
    const { registry, service, endRun } = createHarness();
    const agent = registry.start({
      runId: 'agent-run',
      sessionId: 'conversation-a',
      workspace: process.cwd(),
    });

    const opened = await service.open({
      conversationId: 'conversation-a',
      url: 'https://example.test/path',
      workspace: process.cwd(),
    });
    const userHandle = registry.resolve({
      runId: opened.runId,
      sessionId: 'conversation-a',
    });
    expect(userHandle).toBeDefined();
    expect(registry.getBySessionId('conversation-a')).toBe(agent);
    expect(registry.size).toBe(2);

    await service.end('conversation-a', 'session-switch');
    expect(userHandle?.cancellationRequested).toBe(true);
    expect(endRun).toHaveBeenCalledOnce();
    expect(registry.resolve({ runId: opened.runId, sessionId: 'conversation-a' })).toBeUndefined();
    expect(registry.getBySessionId('conversation-a')).toBe(agent);
    expect(registry.size).toBe(1);
  });

  it('gives a failed open an abnormal terminal and leaves no dangling run', async () => {
    const { registry, service, endRun } = createHarness(false);

    await expect(service.open({
      conversationId: 'conversation-a',
      url: 'https://example.test/fail',
      workspace: process.cwd(),
    })).rejects.toThrow('navigation failed');

    expect(endRun).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('also terminates and unregisters when the adapter throws', async () => {
    const { registry, service, execute, endRun } = createHarness();
    execute.mockRejectedValueOnce(new Error('provider crashed'));

    await expect(service.open({
      conversationId: 'conversation-a',
      url: 'https://example.test/crash',
      workspace: process.cwd(),
    })).rejects.toThrow('provider crashed');

    expect(endRun).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('still ends the Surface run and unregisters when cancellation delivery throws', async () => {
    const { registry, service, endRun } = createHarness();
    const opened = await service.open({
      conversationId: 'conversation-a',
      url: 'https://example.test/path',
      workspace: process.cwd(),
    });
    const userHandle = registry.resolve({
      runId: opened.runId,
      sessionId: 'conversation-a',
    });
    await userHandle?.attach({
      cancel: async () => { throw new Error('cancel delivery failed'); },
    });

    await expect(service.end('conversation-a', 'user')).rejects.toThrow('cancel delivery failed');

    expect(endRun).toHaveBeenCalledOnce();
    expect(registry.resolve({ runId: opened.runId, sessionId: 'conversation-a' })).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});
