import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import { registerSurfaceExecutionHandlers } from '../../../src/host/ipc/surfaceExecution.ipc';
import { SurfaceExecutionRuntimeError } from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntimeError';
import { createDomainRouter } from '../../../src/web/routes/domain';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const snapshot: SurfaceConversationSnapshotV1 = {
  version: 1,
  conversationId: 'conversation-1',
  sessions: [],
  updatedAt: 100,
};

describe('Surface Execution IPC', () => {
  const handlers = new Map<string, WebRouteHandler>();
  const service = {
    getSnapshot: vi.fn(async () => snapshot),
    getFrame: vi.fn(async (request) => ({
      version: 1 as const,
      assetRef: request.assetRef,
      mimeType: 'image/png' as const,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      bytes: 8,
      sha256: 'a'.repeat(64),
    })),
    getOutput: vi.fn(async (request) => ({
      version: 1 as const,
      outputRef: request.outputRef,
      contentKind: 'text' as const,
      mimeType: 'text/html' as const,
      text: '<title>safe</title>',
      truncated: false,
      bytes: 19,
      sha256: 'b'.repeat(64),
    })),
    control: vi.fn(async () => ({ version: 1 as const, snapshot })),
  };
  let server: http.Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerSurfaceExecutionHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never, () => service as never);
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('returns the same owner-aware snapshot through Native IPC and the HTTP domain router', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const request: IPCRequest = {
      action: 'getSnapshot',
      requestId: 'request-1',
      payload: { version: 1, conversationId: 'conversation-1' },
    };
    const nativeResult = await handler(null, request);

    const app = express();
    app.use(express.json());
    app.use('/api', createDomainRouter({
      handlers,
      logger: { warn: vi.fn(), error: vi.fn() },
    }));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test server address');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/domain/surfaceExecution/getSnapshot`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: request.payload, requestId: request.requestId }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(nativeResult);
    expect(service.getSnapshot).toHaveBeenNthCalledWith(1, 'conversation-1');
    expect(service.getSnapshot).toHaveBeenNthCalledWith(2, 'conversation-1');
  });

  it.each(['runId', 'agentId', 'grantId', 'target', 'tabRef', 'windowRef'])(
    'rejects renderer-supplied %s authority before calling the service',
    async (field) => {
      const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
      const result = await handler(null, {
        action: 'getSnapshot',
        payload: {
          version: 1,
          conversationId: 'conversation-1',
          [field]: 'forged-authority',
        },
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGS',
          message: 'version and conversationId are required; authority fields are not accepted.',
        },
      });
      expect(service.getSnapshot).not.toHaveBeenCalled();
    },
  );

  it('accepts only semantic control intent and returns the refreshed snapshot', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const result = await handler(null, {
      action: 'control',
      payload: {
        version: 1,
        conversationId: ' conversation-1 ',
        surfaceSessionId: ' surface-1 ',
        action: 'takeover',
        reason: ' Needs a human check ',
      },
    });

    expect(result).toEqual({ success: true, data: { version: 1, snapshot } });
    expect(service.control).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'takeover',
      reason: 'Needs a human check',
    });
  });

  it('resolves only an owner-scoped opaque frame ref and rejects authority injection', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const payload = {
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      assetRef: 'surface-frame://frame-1',
    };
    await expect(handler(null, { action: 'getFrame', payload })).resolves.toMatchObject({
      success: true,
      data: { assetRef: payload.assetRef, mimeType: 'image/png' },
    });
    expect(service.getFrame).toHaveBeenCalledWith(payload);

    for (const forged of [
      { ...payload, runId: 'run-attacker' },
      { ...payload, assetRef: '/private/tmp/raw-frame.png' },
    ]) {
      await expect(handler(null, { action: 'getFrame', payload: forged })).resolves.toMatchObject({
        success: false,
        error: { code: 'INVALID_ARGS' },
      });
    }
    expect(service.getFrame).toHaveBeenCalledTimes(1);
  });

  it('resolves only an owner-scoped opaque output ref and rejects paths or authority injection', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const payload = {
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      outputRef: 'surface-output://output-1',
    };
    await expect(handler(null, { action: 'getOutput', payload })).resolves.toMatchObject({
      success: true,
      data: { outputRef: payload.outputRef, contentKind: 'text', mimeType: 'text/html' },
    });
    expect(service.getOutput).toHaveBeenCalledWith(payload);

    for (const forged of [
      { ...payload, agentId: 'agent-attacker' },
      { ...payload, outputRef: '/private/tmp/raw-output.html' },
      { ...payload, outputRef: 'file:///private/tmp/raw-output.html' },
    ]) {
      await expect(handler(null, { action: 'getOutput', payload: forged })).resolves.toMatchObject({
        success: false,
        error: { code: 'INVALID_ARGS' },
      });
    }
    expect(service.getOutput).toHaveBeenCalledTimes(1);
  });

  it('accepts durable continuation as a scoped semantic control', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const result = await handler(null, {
      action: 'control',
      payload: {
        version: 1,
        conversationId: 'conversation-1',
        surfaceSessionId: 'surface-checkpoint',
        action: 'continue',
      },
    });

    expect(result).toMatchObject({ success: true });
    expect(service.control).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-checkpoint',
      action: 'continue',
    });
  });

  it('fails closed on unsupported controls and does not accept skip from Renderer', async () => {
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const result = await handler(null, {
      action: 'control',
      payload: {
        version: 1,
        conversationId: 'conversation-1',
        surfaceSessionId: 'surface-1',
        action: 'skip',
      },
    });

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_ARGS' } });
    expect(service.control).not.toHaveBeenCalled();
  });

  it('returns only safe Surface error details for foreign conversations', async () => {
    service.getSnapshot.mockRejectedValueOnce(new SurfaceExecutionRuntimeError({
      code: 'SURFACE_TARGET_NOT_OWNED',
      message: 'Surface execution is unavailable for this conversation.',
      phase: 'human',
      recommendedAction: 'Refresh the accessible conversation list.',
      surface: 'browser',
      provider: 'relay-secret-provider',
      sessionId: 'foreign-surface-id',
      targetRef: {
        kind: 'browser',
        browserInstanceId: 'browser-secret',
        windowRef: 'window-secret',
        tabRef: 'tab-secret',
        documentRevision: 'revision-secret',
      },
    }));
    const handler = handlers.get(IPC_DOMAINS.SURFACE_EXECUTION) as WebRouteHandler;
    const result = await handler(null, {
      action: 'getSnapshot',
      payload: { version: 1, conversationId: 'conversation-foreign' },
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'SURFACE_TARGET_NOT_OWNED',
        message: 'Surface execution is unavailable for this conversation.',
        details: {
          retryable: false,
          userActionRequired: false,
          recommendedAction: 'Refresh the accessible conversation list.',
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/foreign-surface-id|browser-secret|tab-secret|relay-secret/);
  });
});
