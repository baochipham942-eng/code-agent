import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../../../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter', () => ({
  getRelayBrowserProviderAdapter: () => adapter,
}));

import { executeRelayBrowserAction } from '../../../../src/host/services/infra/browser/relayActionFacade';
import {
  inspectBrowserUploadFile,
  relayBrowserUploadApprovalRegistry,
} from '../../../../src/host/services/infra/browser/browserUploadApprovalRegistry';

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

  it('defers Relay download when debugger transport cannot guarantee cancellation cleanup', async () => {
    const result = await executeRelayBrowserAction(
      { action: 'wait_for_download' },
      ownerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      metadata: {
        code: 'SURFACE_CAPABILITY_UNSUPPORTED',
        deferReason: 'relay_download_cancel_cleanup_unavailable',
      },
    });
    expect(result.error).toContain('partial-file cleanup');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('requires and consumes an exact owner-scoped upload approval without forwarding the token', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-facade-upload-'));
    const filePath = path.join(directory, 'canary.txt');
    fs.writeFileSync(filePath, 'relay-upload-canary-bytes');
    try {
      const missing = await executeRelayBrowserAction(
        { action: 'upload_file', targetRef: { ref: 'element:file' } },
        ownerContext(),
      );
      expect(missing).toMatchObject({
        success: false,
        metadata: { code: 'SURFACE_APPROVAL_REQUIRED' },
      });

      const issued = relayBrowserUploadApprovalRegistry.issue({
        owner: {
          conversationId: 'conversation-relay-1',
          runId: 'run-relay-1',
          agentId: 'agent-relay-1',
          operationId: 'operation-relay-1',
        },
        file: inspectBrowserUploadFile(filePath),
      });
      const result = await executeRelayBrowserAction({
        action: 'upload_file',
        targetRef: { ref: 'element:file' },
        relayUploadApprovalToken: issued.token,
      }, ownerContext());

      expect(result.success).toBe(true);
      expect(adapter.execute).toHaveBeenCalledWith(expect.objectContaining({
        operationId: 'operation-relay-1',
        action: 'upload_file',
        params: expect.objectContaining({
          targetRef: { ref: 'element:file' },
          approvedUpload: expect.objectContaining({
            approvalRef: issued.approvalRef,
            normalizedPath: fs.realpathSync.native(filePath),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      }));
      expect(adapter.execute.mock.calls.at(-1)?.[0]?.params).not.toHaveProperty('relayUploadApprovalToken');

      const reused = await executeRelayBrowserAction({
        action: 'upload_file',
        targetRef: { ref: 'element:file' },
        relayUploadApprovalToken: issued.token,
      }, ownerContext());
      expect(reused).toMatchObject({
        success: false,
        metadata: { code: 'SURFACE_APPROVAL_INVALID' },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for clipboard actions because Relay exposes no clipboard transport', async () => {
    for (const action of ['read_clipboard', 'write_clipboard']) {
      const result = await executeRelayBrowserAction(
        { action },
        ownerContext(),
      );
      expect(result).toMatchObject({
        success: false,
        metadata: { code: 'SURFACE_CAPABILITY_UNSUPPORTED' },
      });
    }
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
