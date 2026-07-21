import { once } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RELAY_ACTION_METHODS_V2,
  BROWSER_RELAY_CAPABILITIES_V2,
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
  type BrowserRelayCommandV2,
  type BrowserRelayHelloAckV2,
  type BrowserRelayLeaseRequestV2,
} from '../../../../src/shared/contract/browserRelay';
import {
  BrowserRelayProtocolError,
  BrowserRelayService,
} from '../../../../src/host/services/infra/browserRelayService';

const owner = {
  surfaceSessionId: 'surface-session-a',
  conversationId: 'conversation-a',
  runId: 'run-a',
  agentId: 'agent-a',
};

class RelayMessageStream {
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      const message = JSON.parse(data.toString()) as unknown;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queued.push(message);
    });
  }

  async next(): Promise<Record<string, unknown>> {
    const queued = this.queued.shift();
    if (queued) return queued as Record<string, unknown>;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Relay message.')), 2_000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message as Record<string, unknown>);
      });
    });
  }
}

const services: BrowserRelayService[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
  for (const socket of sockets.splice(0)) socket.terminate();
});

function relayErrorCode(error: unknown): string | undefined {
  return error instanceof BrowserRelayProtocolError ? error.relayError.code : undefined;
}

async function startService(): Promise<{ service: BrowserRelayService; baseUrl: string }> {
  const service = new BrowserRelayService();
  services.push(service);
  const state = await service.ensureStarted(0);
  expect(state.port).toEqual(expect.any(Number));
  return { service, baseUrl: `http://127.0.0.1:${state.port}` };
}

async function connect(
  baseUrl: string,
  options: { hello?: boolean; orphanedLeaseIds?: string[] } = {},
): Promise<RelayMessageStream> {
  const response = await fetch(`${baseUrl}/api/browser-relay/config`, {
    headers: { 'X-Agent-Neo-Relay-Extension': BROWSER_RELAY_PROTOCOL_VERSION_V2 },
  });
  const config = await response.json() as { port: number; token: string };
  const socket = new WebSocket(
    `ws://127.0.0.1:${config.port}/ws/browser-relay?token=${encodeURIComponent(config.token)}`,
  );
  sockets.push(socket);
  const stream = new RelayMessageStream(socket);
  await once(socket, 'open');
  if (options.hello !== false) {
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      extensionInstanceId: 'extension-instance-a',
      capabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
      orphanedLeaseIds: options.orphanedLeaseIds || [],
    }));
    const ack = await stream.next() as unknown as BrowserRelayHelloAckV2;
    expect(ack).toMatchObject({
      type: 'hello_ack',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      connectionGeneration: expect.stringMatching(/^relay-connection-/),
      requiredCapabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
    });
  }
  return stream;
}

async function approveLease(
  service: BrowserRelayService,
  stream: RelayMessageStream,
  requestId = 'lease-request-a',
  actionScopes: string[] = ['navigate', 'screenshot', 'lease:return'],
): Promise<{ leaseId: string; request: BrowserRelayLeaseRequestV2 }> {
  const approval = service.requestTabLease({
    ...owner,
    requestId,
    domainScopes: ['selected-tab-origin'],
    actionScopes,
    ttlMs: 10_000,
  });
  const request = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
  const now = Date.now();
  const leaseId = `opaque-lease-${requestId}`;
  stream.socket.send(JSON.stringify({
    type: 'lease.approved',
    protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
    requestId: request.requestId,
    ...owner,
    leaseId,
    approvalRef: `approval-${requestId}`,
    approvedAt: now,
    expiresAt: Math.min(request.expiresAt, now + 5_000),
    domainScopes: ['origin:https://example.test'],
    actionScopes,
    placement: {
      browserInstanceRef: 'browser:opaque-relay',
      tabRef: 'tab:opaque-relay',
      agentWindowRef: 'window:opaque-agent',
      originalWindowRef: 'window:opaque-user',
      originalIndex: 2,
      originalPinned: true,
      originalActive: true,
      origin: 'https://example.test',
      documentRevision: 'document:one',
    },
  }));
  await expect(approval).resolves.toMatchObject({ leaseId, ...owner });
  return { leaseId, request };
}

describe('BrowserRelayService protocol v2 boundary', () => {
  it('rotates the extension-only pairing token across connections and restarts', async () => {
    const { service, baseUrl } = await startService();
    const getExtensionConfig = async (url: string) => await fetch(`${url}/api/browser-relay/config`, {
      headers: { 'X-Agent-Neo-Relay-Extension': BROWSER_RELAY_PROTOCOL_VERSION_V2 },
    }).then((response) => response.json()) as { port: number; token: string };
    const initial = await getExtensionConfig(baseUrl);
    await connect(baseUrl);
    const afterConnection = await getExtensionConfig(baseUrl);
    expect(afterConnection.token).not.toBe(initial.token);

    const rejected = new WebSocket(
      `ws://127.0.0.1:${initial.port}/ws/browser-relay?token=${encodeURIComponent(initial.token)}`,
    );
    sockets.push(rejected);
    await expect(new Promise<number>((resolve, reject) => {
      rejected.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode || 0);
      });
      rejected.once('error', reject);
    })).resolves.toBe(401);

    await service.stop();
    const restartedState = await service.ensureStarted(0);
    const restarted = await getExtensionConfig(`http://127.0.0.1:${restartedState.port}`);
    expect(restarted.token).not.toBe(afterConnection.token);
  });

  it('keeps bootstrap key material extension-only and hard-denies every raw tab API', async () => {
    const { service, baseUrl } = await startService();
    const publicConfigResponse = await fetch(`${baseUrl}/api/browser-relay/config`);
    const publicConfig = await publicConfigResponse.json() as Record<string, unknown>;
    expect(publicConfig).toMatchObject({
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      tokenHint: expect.any(String),
    });
    expect(publicConfig).not.toHaveProperty('token');
    expect(publicConfigResponse.headers.get('access-control-allow-origin')).toBeNull();

    const extensionConfig = await fetch(`${baseUrl}/api/browser-relay/config`, {
      headers: { 'X-Agent-Neo-Relay-Extension': BROWSER_RELAY_PROTOCOL_VERSION_V2 },
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(extensionConfig.token).toEqual(expect.any(String));
    expect(service.getState()).toMatchObject({ authToken: null, tokenHint: expect.any(String) });
    expect(JSON.stringify(service.getState())).not.toContain(extensionConfig.token as string);

    const rawCalls = [
      service.listTabs(),
      service.createTab('https://example.test'),
      service.navigateTab(1, 'https://example.test'),
      service.attachTab(1),
      service.detachTab(1),
      service.screenshotTab(1),
      service.sendCdp(1, 'Runtime.evaluate'),
    ];
    const settled = await Promise.allSettled(rawCalls);
    expect(settled).toHaveLength(7);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(relayErrorCode(result.reason)).toBe('RELAY_LEASE_REQUIRED');
    }
  });

  it('requires a complete v2 hello before authorization and returns an explicit hello_ack', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl, { hello: false });
    await expect(service.requestTabLease({
      ...owner,
      requestId: 'before-hello',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 5_000,
    })).rejects.toSatisfy((error: unknown) => relayErrorCode(error) === 'RELAY_HANDSHAKE_REQUIRED');

    stream.socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      extensionInstanceId: 'extension-instance-a',
      capabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
      orphanedLeaseIds: [],
    }));
    expect(await stream.next()).toMatchObject({
      type: 'hello_ack',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requiredCapabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
    });
    expect(service.getState()).toMatchObject({ status: 'connected', attachedTabCount: 0 });
  });

  it('accepts only owner-matched, narrowed, unexpired lease approvals', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);

    await expect(service.requestTabLease({
      ...owner,
      requestId: 'wildcard-domain',
      domainScopes: ['*'],
      actionScopes: ['screenshot'],
      ttlMs: 1_000,
    })).rejects.toSatisfy((error: unknown) => relayErrorCode(error) === 'RELAY_DOMAIN_NOT_ALLOWED');
    await expect(service.requestTabLease({
      ...owner,
      requestId: 'unbounded-ttl',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 30 * 60_000 + 1,
    })).rejects.toSatisfy((error: unknown) => relayErrorCode(error) === 'RELAY_ACTION_NOT_ALLOWED');

    const rejectedApproval = service.requestTabLease({
      ...owner,
      requestId: 'wrong-owner',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 5_000,
    });
    const request = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
    stream.socket.send(JSON.stringify({
      type: 'lease.approved',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: request.requestId,
      ...owner,
      agentId: 'agent-attacker',
      leaseId: 'opaque-lease-wrong-owner',
      approvalRef: 'approval-wrong-owner',
      approvedAt: Date.now(),
      expiresAt: request.expiresAt,
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['screenshot'],
      placement: {},
    }));
    await expect(rejectedApproval).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_LEASE_NOT_OWNED',
    );

    const { leaseId } = await approveLease(service, stream, 'valid-lease');
    expect(service.hasActiveLease(leaseId)).toBe(true);
    expect(service.getState().attachedTabCount).toBe(1);

    const hostScopedApproval = service.requestTabLease({
      ...owner,
      requestId: 'host-scoped-lease',
      domainScopes: ['host:example.test'],
      actionScopes: ['screenshot'],
      ttlMs: 5_000,
    });
    const hostScopedRequest = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
    const hostScopedNow = Date.now();
    stream.socket.send(JSON.stringify({
      type: 'lease.approved',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: hostScopedRequest.requestId,
      ...owner,
      leaseId: 'opaque-host-scoped-lease',
      approvalRef: 'approval-host-scoped-lease',
      approvedAt: hostScopedNow,
      expiresAt: Math.min(hostScopedRequest.expiresAt, hostScopedNow + 4_000),
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['screenshot'],
      placement: {
        browserInstanceRef: 'browser:host-scope',
        tabRef: 'tab:host-scope',
        agentWindowRef: 'window:host-scope',
        originalWindowRef: 'window:user',
        originalIndex: 0,
        originalPinned: false,
        originalActive: true,
        origin: 'https://example.test',
        documentRevision: 'document:host-scope',
      },
    }));
    await expect(hostScopedApproval).resolves.toMatchObject({
      leaseId: 'opaque-host-scoped-lease',
      domainScopes: ['origin:https://example.test'],
    });

    await expect(service.executeLeasedCommand({
      ...owner,
      agentId: 'agent-attacker',
      leaseId,
      operationId: 'cross-agent-command',
      actionScope: 'screenshot',
    }, 'tab.screenshot')).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_SESSION_NOT_OWNED',
    );
    await expect(service.executeLeasedCommand({
      ...owner,
      leaseId,
      operationId: 'scope-escalation',
      actionScope: 'get_logs',
    }, 'page.logs')).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_ACTION_NOT_ALLOWED',
    );
    await expect(service.executeLeasedCommand({
      ...owner,
      leaseId,
      operationId: 'method-confusion',
      actionScope: 'screenshot',
    }, 'tab.navigate')).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_ACTION_NOT_ALLOWED',
    );
    await expect(service.executeLeasedCommand({
      ...owner,
      leaseId,
      operationId: 'domain-escalation',
      actionScope: 'navigate',
    }, 'tab.navigate', { url: 'https://evil.invalid' })).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_DOMAIN_NOT_ALLOWED',
    );
    await expect(service.executeLeasedCommand({
      ...owner,
      leaseId,
      operationId: 'raw-native-target',
      actionScope: 'navigate',
    }, 'tab.navigate', {
      url: 'https://example.test/allowed',
      target: { nativeTabId: 42 },
    })).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_TARGET_CHANGED',
    );

    const expiring = service.requestTabLease({
      ...owner,
      requestId: 'short-lived-lease',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 100,
    });
    const expiringRequest = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
    const shortNow = Date.now();
    stream.socket.send(JSON.stringify({
      type: 'lease.approved',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: expiringRequest.requestId,
      ...owner,
      leaseId: 'opaque-short-lived-lease',
      approvalRef: 'approval-short-lived-lease',
      approvedAt: shortNow,
      expiresAt: shortNow + 5,
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['screenshot'],
      placement: {
        browserInstanceRef: 'browser:short-lived',
        tabRef: 'tab:short-lived',
        agentWindowRef: 'window:short-lived-agent',
        originalWindowRef: 'window:short-lived-user',
        originalIndex: 0,
        originalPinned: false,
        originalActive: true,
        origin: 'https://example.test',
        documentRevision: 'document:short-lived',
      },
    }));
    await expect(expiring).resolves.toMatchObject({ leaseId: 'opaque-short-lived-lease' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.hasActiveLease('opaque-short-lived-lease')).toBe(false);
    await expect(service.executeLeasedCommand({
      ...owner,
      leaseId: 'opaque-short-lived-lease',
      operationId: 'expired-command',
      actionScope: 'screenshot',
    }, 'tab.screenshot')).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_LEASE_EXPIRED',
    );
  });

  it('quarantines malformed approvals and immediately returns the moved tab', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const approval = service.requestTabLease({
      ...owner,
      requestId: 'malformed-placement',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 5_000,
    });
    const request = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
    const now = Date.now();
    stream.socket.send(JSON.stringify({
      type: 'lease.approved',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: request.requestId,
      ...owner,
      leaseId: 'opaque-malformed-placement',
      approvalRef: 'approval-malformed-placement',
      approvedAt: now,
      expiresAt: Math.min(request.expiresAt, now + 4_000),
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['screenshot'],
      placement: {
        browserInstanceRef: 'browser:malformed',
        tabRef: 'tab:malformed',
        agentWindowRef: 'window:malformed-agent',
        originalWindowRef: 'window:malformed-user',
        originalIndex: -1,
        originalPinned: false,
        originalActive: true,
        origin: 'https://example.test',
        documentRevision: 'document:malformed',
      },
    }));
    await expect(approval).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_LEASE_NOT_OWNED',
    );
    const returned = await stream.next() as unknown as BrowserRelayCommandV2;
    expect(returned).toMatchObject({
      type: 'command',
      method: 'lease.return',
      leaseId: 'opaque-malformed-placement',
    });
    stream.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId: returned.leaseId,
      ...owner,
    }));
    stream.socket.send(JSON.stringify({
      type: 'response',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: returned.id,
      operationId: returned.operationId,
      result: { returned: true },
    }));
    await vi.waitFor(() => expect(service.getState().attachedTabCount).toBe(0));
  });

  it('propagates cancel, timeout, and extension failures with stable delivery semantics', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const { leaseId } = await approveLease(service, stream);
    const scope = {
      ...owner,
      leaseId,
      operationId: 'operation-abort',
      actionScope: 'navigate',
    };

    const controller = new AbortController();
    const aborted = service.executeLeasedCommand(
      { ...scope, abortSignal: controller.signal },
      'tab.navigate',
      { url: 'https://example.test/next' },
    );
    const abortedAssertion = expect(aborted).rejects.toSatisfy((error: unknown) => (
      relayErrorCode(error) === 'RELAY_OPERATION_CANCELLED'
      && (error as BrowserRelayProtocolError).relayError.delivery === 'unknown'
    ));
    const command = await stream.next() as unknown as BrowserRelayCommandV2;
    expect(command).toMatchObject({ type: 'command', ...owner, leaseId, operationId: 'operation-abort' });
    controller.abort('user-stop');
    expect(await stream.next()).toMatchObject({
      type: 'cancel',
      ...owner,
      leaseId,
      operationId: 'operation-abort',
      reason: 'user-stop',
    });
    await abortedAssertion;

    const timedOut = service.executeLeasedCommand(
      { ...scope, operationId: 'operation-timeout', deadlineMs: 5 },
      'tab.navigate',
      { url: 'https://example.test/timeout' },
    );
    const timeoutAssertion = expect(timedOut).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_OPERATION_TIMEOUT',
    );
    expect(await stream.next()).toMatchObject({ type: 'command', operationId: 'operation-timeout' });
    expect(await stream.next()).toMatchObject({ type: 'cancel', operationId: 'operation-timeout', reason: 'host-timeout' });
    await timeoutAssertion;

    const failed = service.executeLeasedCommand(
      { ...scope, operationId: 'operation-extension-error', actionScope: 'screenshot' },
      'tab.screenshot',
    );
    const failedCommand = await stream.next() as unknown as BrowserRelayCommandV2;
    stream.socket.send(JSON.stringify({
      type: 'response',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: failedCommand.id,
      operationId: failedCommand.operationId,
      error: {
        code: 'EXTENSION_PRIVATE_ERROR',
        message: 'private extension trace',
        retryable: false,
        delivery: 'not_attempted',
      },
    }));
    await expect(failed).rejects.toSatisfy((error: unknown) => (
      relayErrorCode(error) === 'RELAY_COMMAND_FAILED'
      && (error as BrowserRelayProtocolError).relayError.delivery === 'not_attempted'
    ));

    const alreadyAbortedController = new AbortController();
    alreadyAbortedController.abort('pre-aborted');
    const alreadyAborted = service.executeLeasedCommand(
      { ...scope, operationId: 'operation-pre-aborted', abortSignal: alreadyAbortedController.signal },
      'tab.navigate',
      { url: 'https://example.test/not-sent' },
    );
    await expect(alreadyAborted).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_OPERATION_CANCELLED',
    );
    expect(await stream.next()).toMatchObject({
      type: 'cancel',
      operationId: 'operation-pre-aborted',
      reason: 'pre-aborted',
    });
  });

  it('reports unknown delivery for every Relay mutation that times out after dispatch', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const mutationScopes = ['hover', 'drag', 'handle_dialog', 'upload_file'] as const;
    const { leaseId } = await approveLease(
      service,
      stream,
      'mutation-delivery',
      [...mutationScopes, 'lease:return'],
    );

    for (const actionScope of mutationScopes) {
      const pending = service.executeLeasedCommand({
        ...owner,
        leaseId,
        operationId: `operation-timeout-${actionScope}`,
        actionScope,
        deadlineMs: 5,
      }, BROWSER_RELAY_ACTION_METHODS_V2[actionScope], {});
      const assertion = expect(pending).rejects.toSatisfy((error: unknown) => (
        relayErrorCode(error) === 'RELAY_OPERATION_TIMEOUT'
        && (error as BrowserRelayProtocolError).relayError.delivery === 'unknown'
      ));
      expect(await stream.next()).toMatchObject({
        type: 'command',
        operationId: `operation-timeout-${actionScope}`,
        actionScope,
      });
      expect(await stream.next()).toMatchObject({
        type: 'cancel',
        operationId: `operation-timeout-${actionScope}`,
        reason: 'host-timeout',
      });
      await assertion;
    }
  });

  it('automatically returns an approval that arrives after its Host request expired', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const approval = service.requestTabLease({
      ...owner,
      requestId: 'late-approval',
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot'],
      ttlMs: 5,
    });
    const request = await stream.next() as unknown as BrowserRelayLeaseRequestV2;
    await expect(approval).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_OPERATION_TIMEOUT',
    );
    expect(await stream.next()).toMatchObject({
      type: 'lease.request.cancel',
      requestId: request.requestId,
      reason: 'host-consent-timeout',
      ...owner,
    });

    stream.socket.send(JSON.stringify({
      type: 'lease.approved',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: request.requestId,
      ...owner,
      leaseId: 'opaque-late-approval',
      approvalRef: 'approval-late-approval',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 5_000,
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['screenshot'],
      placement: {},
    }));
    const returned = await stream.next() as unknown as BrowserRelayCommandV2;
    expect(returned).toMatchObject({
      type: 'command',
      method: 'lease.return',
      actionScope: 'lease:return',
      leaseId: 'opaque-late-approval',
      operationId: 'late-approval-return:late-approval',
    });
    stream.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId: returned.leaseId,
      ...owner,
    }));
    stream.socket.send(JSON.stringify({
      type: 'response',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: returned.id,
      operationId: returned.operationId,
      result: { returned: true },
    }));
    await vi.waitFor(() => expect(service.getState().attachedTabCount).toBe(0));
  });

  it('refuses a global stop while a Surface owns a tab lease', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const { leaseId } = await approveLease(service, stream, 'stop-return');
    await expect(service.stop()).rejects.toSatisfy(
      (error: unknown) => relayErrorCode(error) === 'RELAY_LEASE_REQUIRED',
    );
    expect(service.hasActiveLease(leaseId)).toBe(true);

    const returning = service.returnTabLease({
      ...owner,
      leaseId,
      operationId: 'surface-cleanup-return',
      deadlineMs: 1_000,
    });
    const returned = await stream.next() as unknown as BrowserRelayCommandV2;
    expect(returned).toMatchObject({
      type: 'command',
      method: 'lease.return',
      actionScope: 'lease:return',
      leaseId,
    });
    stream.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId,
      ...owner,
    }));
    stream.socket.send(JSON.stringify({
      type: 'response',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: returned.id,
      operationId: returned.operationId,
      result: { returned: true },
    }));

    await expect(returning).resolves.toMatchObject({ returned: true });
    await expect(service.stop()).resolves.toMatchObject({ status: 'stopped', attachedTabCount: 0 });
  });

  it('publishes lease lifecycle only after exact owner validation', async () => {
    const { service, baseUrl } = await startService();
    const stream = await connect(baseUrl);
    const { leaseId } = await approveLease(service, stream, 'lifecycle-return');
    const listener = vi.fn();
    service.onLeaseLifecycle(listener);

    stream.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId,
      ...owner,
      agentId: 'agent-attacker',
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();
    expect(service.hasActiveLease(leaseId)).toBe(true);

    stream.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId,
      ...owner,
    }));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lease.returned',
      leaseId,
      ...owner,
    }));
    expect(service.hasActiveLease(leaseId)).toBe(false);
  });

  it('retains an orphaned lease across reconnect so the exact owner can retry return', async () => {
    const { service, baseUrl } = await startService();
    const firstStream = await connect(baseUrl);
    const { leaseId } = await approveLease(service, firstStream, 'reconnect-return');
    const disconnected = vi.fn();
    const lifecycle = vi.fn();
    service.onDisconnect(disconnected);
    service.onLeaseLifecycle(lifecycle);

    const closed = once(firstStream.socket, 'close');
    firstStream.socket.close();
    await closed;
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledWith([leaseId]));
    expect(service.hasActiveLease(leaseId)).toBe(false);

    const reconnected = await connect(baseUrl, { orphanedLeaseIds: [leaseId] });
    const returning = service.returnTabLease({
      ...owner,
      leaseId,
      operationId: 'retry-return-after-reconnect',
      deadlineMs: 1_000,
    });
    const command = await reconnected.next() as unknown as BrowserRelayCommandV2;
    expect(command).toMatchObject({
      type: 'command',
      method: 'lease.return',
      actionScope: 'lease:return',
      leaseId,
      ...owner,
    });
    reconnected.socket.send(JSON.stringify({
      type: 'lease.returned',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId,
      ...owner,
    }));
    reconnected.socket.send(JSON.stringify({
      type: 'response',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: command.id,
      operationId: command.operationId,
      result: { returned: true },
    }));

    await expect(returning).resolves.toMatchObject({ returned: true });
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lease.returned',
      leaseId,
      ...owner,
    }));
    expect(service.getState().attachedTabCount).toBe(0);
  });
});
