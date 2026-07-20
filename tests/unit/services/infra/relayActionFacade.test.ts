import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../../../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter', () => ({
  getRelayBrowserProviderAdapter: () => adapter,
}));

import { executeRelayBrowserAction } from '../../../../src/host/services/infra/browser/relayActionFacade';

function ownerContext() {
  return {
    sessionId: 'conversation-relay-1',
    runId: 'run-relay-1',
    agentId: 'agent-relay-1',
    currentToolCallId: 'operation-relay-1',
    workingDirectory: '/tmp/workbench',
    requestPermission: vi.fn(),
    abortSignal: new AbortController().signal,
    emit: vi.fn(),
  };
}

describe('relayActionFacade protocol v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'leased action complete',
      metadata: { provider: 'browser-relay', engine: 'relay' },
    });
  });

  it('fails closed without the durable conversation/run/agent/operation owner', async () => {
    const result = await executeRelayBrowserAction({ action: 'get_content' });
    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'SURFACE_TARGET_NOT_OWNED' },
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('delegates only owner-scoped opaque Relay parameters', async () => {
    const context = ownerContext();
    const result = await executeRelayBrowserAction({
      action: 'click',
      selector: 'button.submit',
      relayDomainScopes: ['https://example.test'],
      relayActionScopes: ['click', 'get_dom_snapshot'],
      relayLeaseTtlMs: 60_000,
    }, context);

    expect(result.success).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        conversationId: 'conversation-relay-1',
        runId: 'run-relay-1',
        agentId: 'agent-relay-1',
      }),
      operationId: 'operation-relay-1',
      action: 'click',
      params: expect.not.objectContaining({ tabId: expect.anything() }),
    }));
  });

  it('keeps profile and storage actions on Managed Browser', async () => {
    const result = await executeRelayBrowserAction(
      { action: 'import_profile_cookies' },
      ownerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'SURFACE_CAPABILITY_UNSUPPORTED' },
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('forwards Surface events through the existing ToolContext emitter', async () => {
    const context = ownerContext();
    adapter.execute.mockImplementationOnce(async (input: {
      identity: { emitSurfaceEvent(event: unknown): void };
    }) => {
      input.identity.emitSurfaceEvent({ eventId: 'surface-event-1' });
      return { success: true, output: 'ok' };
    });

    await executeRelayBrowserAction({ action: 'screenshot' }, context);
    expect(context.emit).toHaveBeenCalledWith('surface_execution', { eventId: 'surface-event-1' });
  });
});
