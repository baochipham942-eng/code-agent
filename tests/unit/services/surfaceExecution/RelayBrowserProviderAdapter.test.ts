import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { inspectBrowserUploadFile } from '../../../../src/host/services/infra/browser/browserUploadApprovalRegistry';
import type {
  BrowserRelayCommandScopeV2,
  BrowserRelayService,
} from '../../../../src/host/services/infra/browserRelayService';
import type { BrowserRelayLeaseReturnResultV2 } from '../../../../src/shared/contract/browserRelay';
import {
  RelayBrowserProviderAdapter,
  type RelayBrowserActionInput,
} from '../../../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

type LeaseRequest = Parameters<BrowserRelayService['requestTabLease']>[0];

function createHarness(identityOverrides: Partial<SurfaceRuntimeIdentityV1> = {}) {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-relay', sessionId: 'conversation-relay', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-relay',
    runId: 'run-relay',
    agentId: 'agent-relay',
    ...identityOverrides,
  };
  const activeLeaseIds = new Set<string>();
  const commandCalls: Array<{
    scope: BrowserRelayCommandScopeV2;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const returnCalls: Array<Omit<BrowserRelayCommandScopeV2, 'actionScope'>> = [];
  let disconnectListener: ((leaseIds: string[]) => void) | null = null;
  let leaseLifecycleListener: ((result: BrowserRelayLeaseReturnResultV2) => void) | null = null;
  let returnFailure: Error | null = null;
  let emitLifecycleOnReturn = false;
  let revision = 1;
  const relay = {
    onDisconnect(listener: (leaseIds: string[]) => void) {
      disconnectListener = listener;
      return () => { disconnectListener = null; };
    },
    onLeaseLifecycle(listener: (result: BrowserRelayLeaseReturnResultV2) => void) {
      leaseLifecycleListener = listener;
      return () => { leaseLifecycleListener = null; };
    },
    hasActiveLease(leaseId: string) {
      return activeLeaseIds.has(leaseId);
    },
    getConnectionGeneration() {
      return 'relay-connection-generation-a';
    },
    async requestTabLease(request: LeaseRequest) {
      const leaseId = 'extension-lease-opaque-a';
      activeLeaseIds.add(leaseId);
      const now = Date.now();
      return {
        type: 'lease.approved' as const,
        protocolVersion: '2.2' as const,
        requestId: request.requestId,
        surfaceSessionId: request.surfaceSessionId,
        conversationId: request.conversationId,
        runId: request.runId,
        agentId: request.agentId,
        leaseId,
        approvalRef: 'approval-ref-opaque-a',
        approvedAt: now,
        expiresAt: now + 120_000,
        domainScopes: ['origin:https://example.test'],
        actionScopes: [...request.actionScopes],
        placement: {
          browserInstanceRef: 'browser:opaque-relay-a',
          tabRef: 'tab:opaque-relay-a',
          agentWindowRef: 'window:opaque-agent-a',
          originalWindowRef: 'window:opaque-user-a',
          originalIndex: 3,
          originalPinned: true,
          originalActive: true,
          origin: 'https://example.test',
          documentRevision: 'document:1',
        },
      };
    },
    async executeLeasedCommand(
      scope: BrowserRelayCommandScopeV2,
      method: string,
      params: Record<string, unknown>,
    ) {
      commandCalls.push({ scope, method, params });
      revision += 1;
      if (method === 'dom.set_file_input_files') {
        return {
          output: 'file input assigned',
          fileAssigned: true,
          fileCount: 1,
          fileSize: fs.statSync(String(params.uploadFilePath)).size,
          target: {
            origin: 'https://example.test',
            documentRevision: `document:${revision}`,
          },
        };
      }
      if (method === 'page.logs') {
        return {
          output: '2 redacted browser log entries available.',
          entries: [{
            cursor: 7,
            level: 'info',
            source: 'network',
            text: 'request POST token=surface-secret-canary-host-boundary',
            url: 'https://example.test/api/commit?token=surface-secret-canary-host-boundary',
            timestamp: 123,
            headers: { authorization: 'Bearer surface-secret-canary-host-boundary' },
          }],
          nextCursor: 7,
          target: {
            origin: 'https://example.test',
            documentRevision: `document:${revision}`,
          },
        };
      }
      if (method === 'dialog.get') {
        return {
          output: 'A confirm dialog is paused for explicit handling.',
          pending: true,
          type: 'confirm',
          messageLength: 37,
          openedAtMs: 123,
          defaultPolicy: 'pause',
          target: {
            origin: 'https://example.test',
            documentRevision: `document:${revision}`,
          },
        };
      }
      if (method === 'dialog.handle') {
        return {
          output: 'Dismissed the paused confirm dialog.',
          handled: true,
          type: 'confirm',
          action: params.dialogAction,
          defaultPolicy: 'pause',
          target: {
            origin: 'https://example.test',
            documentRevision: `document:${revision}`,
          },
        };
      }
      return {
        output: `${method} complete`,
        target: {
          origin: 'https://example.test',
          documentRevision: `document:${revision}`,
          title: 'Safe title',
        },
        evidenceRefs: [`evidence:${revision}`],
        elements: [{
          ref: 'element:save',
          backendNodeId: 42,
          role: 'button',
          name: 'Save',
          bounds: { x: 10, y: 10, width: 80, height: 30 },
        }],
      };
    },
    async returnTabLease(scope: Omit<BrowserRelayCommandScopeV2, 'actionScope'>) {
      returnCalls.push(scope);
      if (returnFailure) throw returnFailure;
      if (emitLifecycleOnReturn) {
        leaseLifecycleListener?.({
          type: 'lease.returned',
          protocolVersion: '2.2',
          leaseId: scope.leaseId,
          surfaceSessionId: scope.surfaceSessionId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          agentId: scope.agentId,
        });
      }
      activeLeaseIds.delete(scope.leaseId);
      return { returned: true };
    },
  } as unknown as BrowserRelayService;
  const adapter = new RelayBrowserProviderAdapter(relay, runtime);
  const execute = (action: string, params: Record<string, unknown> = {}) => adapter.execute({
    identity,
    operationId: `operation-${action}`,
    action,
    params,
  });
  return {
    adapter,
    registry,
    runtime,
    identity,
    relay,
    activeLeaseIds,
    commandCalls,
    returnCalls,
    execute,
    emitDisconnect(leaseIds: string[]) { disconnectListener?.(leaseIds); },
    emitLeaseReturned(ownerOverrides: Partial<BrowserRelayLeaseReturnResultV2> = {}) {
      leaseLifecycleListener?.({
        type: 'lease.returned',
        protocolVersion: '2.2',
        surfaceSessionId: adapter.getBinding(identity)?.surfaceSessionId || '',
        conversationId: identity.conversationId,
        runId: identity.runId,
        agentId: identity.agentId,
        leaseId: 'extension-lease-opaque-a',
        ...ownerOverrides,
      });
    },
    failReturns(error: Error | null) { returnFailure = error; },
    emitLifecycleDuringReturn() { emitLifecycleOnReturn = true; },
  };
}

describe('RelayBrowserProviderAdapter', () => {
  it('projects a serializable binding view while retaining the runtime event emitter', async () => {
    const emitSurfaceEvent = vi.fn();
    const harness = createHarness({ emitSurfaceEvent, turnId: 'turn-relay' });

    await harness.execute('launch');

    expect(() => harness.adapter.getBinding(harness.identity)).not.toThrow();
    expect(harness.adapter.getBinding(harness.identity)?.identity).toEqual({
      conversationId: 'conversation-relay',
      runId: 'run-relay',
      turnId: 'turn-relay',
      agentId: 'agent-relay',
    });
    expect(emitSurfaceEvent).toHaveBeenCalled();
  });

  it('projects extension approval into the shared Surface runtime and clamps Host consent TTL', async () => {
    const harness = createHarness();
    const consentSpy = vi.spyOn(harness.runtime.browserTabLeases, 'requestConsent');
    const result = await harness.execute('launch', {
      relayDomainScopes: ['selected-tab-origin'],
      relayActionScopes: ['get_content', 'click', 'lease:return'],
      relayLeaseTtlMs: 120_000,
    });

    expect(result).toMatchObject({
      success: true,
      metadata: {
        provider: 'browser-relay',
        engine: 'relay',
        surfaceSessionId: expect.any(String),
        relayLeaseId: expect.any(String),
      },
    });
    expect(consentSpy).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: 60_000 }));
    const binding = harness.adapter.getBinding(harness.identity);
    expect(binding).toMatchObject({
      identity: harness.identity,
      extensionLeaseId: 'extension-lease-opaque-a',
      target: {
        browserInstanceId: 'browser:opaque-relay-a',
        tabRef: 'tab:opaque-relay-a',
        windowRef: 'window:opaque-agent-a',
        origin: 'https://example.test',
        documentRevision: 'document:1',
      },
      lease: {
        state: 'leased',
        originalPlacement: { windowRef: 'window:opaque-user-a', index: 3, pinned: true },
        domainScopes: ['origin:https://example.test'],
        actionScopes: ['get_content', 'click', 'lease:return'],
      },
    });
    expect(harness.runtime.sessions.get(binding?.surfaceSessionId || '')).toMatchObject({
      surface: 'browser',
      provider: 'browser-relay',
      state: 'running',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    });
  });

  it('routes reads and mutations through owner-scoped Relay commands and Surface results', async () => {
    const harness = createHarness();
    await harness.execute('launch');

    const observed = await harness.execute('get_content');
    expect(observed).toMatchObject({
      success: true,
      metadata: {
        provider: 'browser-relay',
        surfaceObservationV1: {
          target: { documentRevision: 'document:2' },
          evidenceAssetIds: ['evidence:2'],
        },
        surfaceExecutionEventsV1: expect.any(Array),
      },
    });
    const clicked = await harness.execute('click', {
      targetRef: {
        kind: 'browser-element',
        ref: 'element:save',
        tabRef: 'tab:opaque-relay-a',
        documentRevision: 'document:2',
        backendNodeId: 42,
      },
    });
    expect(clicked).toMatchObject({
      success: true,
      metadata: {
        provider: 'browser-relay',
        surfaceExecutionActionResultV1: {
          delivery: 'confirmed',
          verification: 'not_requested',
          overall: 'delivered_unverified',
          successorState: { target: { documentRevision: 'document:3' } },
        },
      },
    });
    expect(harness.commandCalls).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({ ...harness.identity, actionScope: 'get_content' }),
        method: 'page.content',
      }),
      expect.objectContaining({
        scope: expect.objectContaining({ ...harness.identity, actionScope: 'click' }),
        method: 'input.click',
        params: {
          targetRef: expect.objectContaining({ backendNodeId: 42, documentRevision: 'document:2' }),
        },
      }),
    ]);
  });

  it('uploads one Host-approved exact file and returns only safe artifact metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-adapter-upload-'));
    const filePath = path.join(directory, 'surface-secret-canary-upload.txt');
    fs.writeFileSync(filePath, 'relay upload fixture bytes');
    try {
      const harness = createHarness();
      await harness.execute('launch', {
        relayActionScopes: ['get_dom_snapshot', 'upload_file', 'lease:return'],
      });
      await harness.execute('get_dom_snapshot');
      const file = inspectBrowserUploadFile(filePath);

      const uploaded = await harness.execute('upload_file', {
        targetRef: {
          kind: 'browser-element',
          ref: 'element:save',
          tabRef: 'tab:opaque-relay-a',
          documentRevision: 'document:2',
          backendNodeId: 42,
        },
        approvedUpload: {
          approvalRef: 'upload-approval-opaque',
          ...file,
        },
      });

      expect(uploaded).toMatchObject({
        success: true,
        output: expect.stringContaining('surface-secret-canary-upload.txt'),
        metadata: {
          browserArtifact: {
            kind: 'upload',
            name: 'surface-secret-canary-upload.txt',
            artifactPath: '.../surface-secret-canary-upload.txt',
            size: file.size,
            sha256: file.sha256,
            sessionId: expect.stringMatching(/^surface_/),
          },
          surfaceExecutionActionResultV1: {
            delivery: 'confirmed',
            verification: 'satisfied',
            overall: 'succeeded',
            artifactRefs: [expect.stringMatching(/^upload_/)],
          },
          browserUploadVerification: {
            fileAssigned: true,
            fileCount: 1,
            fileSize: file.size,
          },
        },
      });
      expect(harness.commandCalls.at(-1)).toMatchObject({
        scope: expect.objectContaining({ actionScope: 'upload_file' }),
        method: 'dom.set_file_input_files',
        params: {
          targetRef: expect.objectContaining({ ref: 'element:save' }),
          uploadApprovalRef: 'upload-approval-opaque',
          uploadFilePath: fs.realpathSync.native(filePath),
        },
      });
      expect(JSON.stringify(uploaded)).not.toContain(directory);
      expect(JSON.stringify(uploaded)).not.toContain('relay upload fixture bytes');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports unknown delivery without an artifact when approved bytes change during assignment', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-adapter-upload-race-'));
    const filePath = path.join(directory, 'race-canary.txt');
    fs.writeFileSync(filePath, 'approved-before-delivery');
    try {
      const harness = createHarness();
      await harness.execute('launch', {
        relayActionScopes: ['get_dom_snapshot', 'upload_file', 'lease:return'],
      });
      await harness.execute('get_dom_snapshot');
      const file = inspectBrowserUploadFile(filePath);
      const executeCommand = harness.relay.executeLeasedCommand.bind(harness.relay);
      vi.spyOn(harness.relay, 'executeLeasedCommand').mockImplementation(async (...args) => {
        const result = await executeCommand(...args);
        if (args[1] === 'dom.set_file_input_files') {
          fs.writeFileSync(filePath, 'surface-secret-canary-mutated-after-delivery');
        }
        return result;
      });

      const uploaded = await harness.execute('upload_file', {
        targetRef: {
          kind: 'browser-element',
          ref: 'element:save',
          tabRef: 'tab:opaque-relay-a',
          documentRevision: 'document:2',
          backendNodeId: 42,
        },
        approvedUpload: { approvalRef: 'upload-approval-race', ...file },
      });

      expect(uploaded).toMatchObject({
        success: false,
        metadata: {
          surfaceExecutionErrorV1: {
            code: 'SURFACE_DELIVERY_UNKNOWN',
            phase: 'verify',
          },
        },
      });
      expect(uploaded.metadata).not.toHaveProperty('browserArtifact');
      expect(JSON.stringify(uploaded)).not.toContain(directory);
      expect(JSON.stringify(uploaded)).not.toContain('surface-secret-canary-mutated-after-delivery');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('projects only safe dialog metadata and keeps high-risk handling out of default scope', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);

    expect(binding?.lease.actionScopes).toEqual(expect.arrayContaining([
      'hover',
      'drag',
      'get_dialog_state',
    ]));
    expect(binding?.lease.actionScopes).not.toContain('handle_dialog');
    expect(binding?.lease.actionScopes).not.toContain('upload_file');

    const state = await harness.execute('get_dialog_state');
    expect(state).toMatchObject({
      success: true,
      metadata: {
        browserDialogState: {
          pending: true,
          type: 'confirm',
          messageLength: 37,
          openedAtMs: 123,
          defaultPolicy: 'pause',
        },
      },
    });
    expect(state.metadata?.browserDialogState).not.toHaveProperty('message');
  });

  it('dispatches dialog handling only when the lease explicitly includes that action', async () => {
    const harness = createHarness();
    await harness.execute('launch', {
      relayActionScopes: ['get_dialog_state', 'handle_dialog', 'lease:return'],
    });
    await harness.execute('get_dialog_state');

    const dismissed = await harness.execute('handle_dialog', { dialogAction: 'dismiss' });
    expect(dismissed).toMatchObject({
      success: true,
      metadata: {
        browserDialogState: {
          pending: false,
          handled: true,
          type: 'confirm',
          action: 'dismiss',
          defaultPolicy: 'pause',
        },
        surfaceExecutionActionResultV1: { delivery: 'confirmed' },
      },
    });
    expect(harness.commandCalls.at(-1)).toMatchObject({
      method: 'dialog.handle',
      params: { dialogAction: 'dismiss' },
    });
  });

  it('projects only Host-redacted console/network metadata with a monotonic cursor', async () => {
    const harness = createHarness();
    await harness.execute('launch');

    const logs = await harness.execute('get_logs', { afterCursor: 0 });

    expect(logs).toMatchObject({
      success: true,
      metadata: {
        surfaceBrowserLogCursorV1: {
          version: 1,
          nextCursor: 7,
          entries: [{
            cursor: 7,
            source: 'network',
            text: 'request POST [redacted]',
            url: 'https://example.test/api/commit',
          }],
        },
      },
    });
    expect(JSON.stringify(logs)).not.toContain('surface-secret-canary-host-boundary');
    expect(JSON.stringify(logs)).not.toContain('authorization');
  });

  it('fences other agents and returns the borrowed tab during Surface cleanup', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const crossAgent: RelayBrowserActionInput = {
      identity: { ...harness.identity, agentId: 'agent-attacker' },
      operationId: 'operation-cross-agent',
      action: 'get_content',
      params: {},
    };
    expect(await harness.adapter.execute(crossAgent)).toMatchObject({
      success: false,
      metadata: {
        surfaceExecutionErrorV1: { code: 'BROWSER_TAB_BORROW_REQUIRED' },
      },
    });
    expect(harness.commandCalls).toHaveLength(0);

    const closed = await harness.execute('close');
    expect(closed).toMatchObject({
      success: true,
      output: expect.stringContaining('returned'),
    });
    expect(harness.returnCalls).toEqual([
      expect.objectContaining({
        ...harness.identity,
        surfaceSessionId: binding?.surfaceSessionId,
        leaseId: 'extension-lease-opaque-a',
        operationId: 'operation-launch:return',
      }),
    ]);
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();
    expect(harness.runtime.browserTabLeases.getOwned(
      binding?.hostLeaseId || '',
      {
        conversationId: harness.identity.conversationId,
        sessionId: binding?.surfaceSessionId || '',
        runId: harness.identity.runId,
        agentId: harness.identity.agentId,
      },
    )).toMatchObject({ state: 'returned' });
    expect(harness.runtime.sessions.get(binding?.surfaceSessionId || '')).toMatchObject({ state: 'completed' });
  });

  it('marks the Host lease orphaned when the extension disconnects', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    harness.emitDisconnect(['extension-lease-opaque-a']);
    expect(harness.runtime.browserTabLeases.getOwned(
      binding?.hostLeaseId || '',
      {
        conversationId: harness.identity.conversationId,
        sessionId: binding?.surfaceSessionId || '',
        runId: harness.identity.runId,
        agentId: harness.identity.agentId,
      },
    )).toMatchObject({ state: 'orphaned', recoveryCode: 'provider_disconnected' });
    expect(harness.adapter.hasReadyLease(harness.identity)).toBe(false);
  });

  it('returns the borrowed tab when Host projection fails after extension approval', async () => {
    const harness = createHarness();
    vi.spyOn(harness.runtime, 'recordBrowserObservation').mockImplementationOnce(() => {
      throw new Error('injected Host projection failure');
    });

    const result = await harness.execute('launch');
    expect(result).toMatchObject({ success: false, error: 'injected Host projection failure' });
    expect(harness.returnCalls).toEqual([
      expect.objectContaining({
        ...harness.identity,
        leaseId: 'extension-lease-opaque-a',
        operationId: 'operation-launch:rollback-return',
      }),
    ]);
    expect(harness.activeLeaseIds.size).toBe(0);
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();

    const [session] = harness.runtime.sessions.listByConversationOwned(
      harness.identity.conversationId,
      harness.identity,
    );
    const [lease] = harness.runtime.browserTabLeases.listOwned({
      conversationId: harness.identity.conversationId,
      sessionId: session.sessionId,
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    });
    expect(lease.state).toBe('returned');
  });

  it('returns the borrowed tab during stop before end_session finalizes state', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const subject = {
      sessionId: binding?.surfaceSessionId || '',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    };

    await harness.runtime.control(subject, 'stop');
    expect(harness.returnCalls).toHaveLength(1);
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();
    expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('stopping');
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', {
      conversationId: harness.identity.conversationId,
      ...subject,
    })).toMatchObject({ state: 'returned' });

    await harness.runtime.control(subject, 'end_session');
    expect(harness.returnCalls).toHaveLength(1);
    expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('completed');
  });

  it('keeps failed Relay cleanup recoverable for the exact owner and blocks a different Agent', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const subject = {
      sessionId: binding?.surfaceSessionId || '',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    };
    const leaseSubject = { conversationId: harness.identity.conversationId, ...subject };
    harness.emitDisconnect(['extension-lease-opaque-a']);
    harness.failReturns(new Error('relay handshake unavailable'));

    await expect(harness.runtime.control(subject, 'end_session')).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_CLEANUP_FAILED', retryable: true },
    });
    expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('stopping');
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject))
      .toMatchObject({ state: 'recovery_required', recoveryCode: 'return_failed' });
    await expect(harness.runtime.control({ ...subject, agentId: 'agent-attacker' }, 'end_session'))
      .rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });

    harness.failReturns(null);
    await harness.runtime.control(subject, 'end_session');
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject))
      .toMatchObject({ state: 'returned' });
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();
    expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('completed');
  });

  it('reconciles only an owner-matched extension return after disconnect cleanup fails', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const subject = {
      sessionId: binding?.surfaceSessionId || '',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    };
    const leaseSubject = { conversationId: harness.identity.conversationId, ...subject };
    harness.emitDisconnect(['extension-lease-opaque-a']);
    harness.failReturns(new Error('relay handshake unavailable'));
    await expect(harness.runtime.control(subject, 'end_session')).rejects.toBeTruthy();

    harness.emitLeaseReturned({ agentId: 'agent-attacker' });
    await Promise.resolve();
    expect(harness.adapter.getBinding(harness.identity)).not.toBeNull();
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject))
      .toMatchObject({ state: 'recovery_required' });

    harness.registry.unregister(harness.identity.runId);
    harness.emitLeaseReturned();
    await vi.waitFor(() => {
      expect(harness.adapter.getBinding(harness.identity)).toBeNull();
      expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('completed');
    });
    const returnedLease = await harness.runtime.sessions.withCancellingOwnerCleanup(
      subject.sessionId,
      subject,
      async () => harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject),
    );
    expect(returnedLease).toMatchObject({ state: 'returned' });
  });

  it('reconciles an owner-matched expiry return without granting further Relay actions', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const subject = {
      sessionId: binding?.surfaceSessionId || '',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    };
    const leaseSubject = { conversationId: harness.identity.conversationId, ...subject };

    harness.emitLeaseReturned();
    await vi.waitFor(() => expect(harness.runtime.sessions.get(subject.sessionId)?.state).toBe('completed'));
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject))
      .toMatchObject({ state: 'returned' });
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();
    expect(await harness.adapter.execute({
      identity: harness.identity,
      operationId: 'operation-after-expiry-return',
      action: 'get_content',
      params: {},
    })).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'BROWSER_TAB_BORROW_REQUIRED' } },
    });
  });

  it('keeps normal Host return idempotent when lease.returned arrives before the command response', async () => {
    const harness = createHarness();
    await harness.execute('launch');
    const binding = harness.adapter.getBinding(harness.identity);
    const leaseSubject = {
      conversationId: harness.identity.conversationId,
      sessionId: binding?.surfaceSessionId || '',
      runId: harness.identity.runId,
      agentId: harness.identity.agentId,
    };
    harness.emitLifecycleDuringReturn();

    await expect(harness.execute('close')).resolves.toMatchObject({ success: true });
    expect(harness.runtime.browserTabLeases.getOwned(binding?.hostLeaseId || '', leaseSubject))
      .toMatchObject({ state: 'returned' });
    expect(harness.runtime.sessions.get(binding?.surfaceSessionId || '')?.state).toBe('completed');
    expect(harness.adapter.getBinding(harness.identity)).toBeNull();
  });
});
