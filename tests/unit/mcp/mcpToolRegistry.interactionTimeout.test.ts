import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants';
import type { MCPElicitationResponse } from '../../../src/shared/contract';
import { setBrowserWindowInteractionProbe } from '../../../src/host/platform/windowBridge';

const platformMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  getAllWindows: vi.fn(),
  hasInteractiveUi: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: platformMocks.handle },
  hasInteractiveUi: platformMocks.hasInteractiveUi,
  AppWindow: { getAllWindows: platformMocks.getAllWindows },
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { registerElicitationHandler } from '../../../src/host/mcp/mcpElicitation';
import { requestMcpOAuthConsent } from '../../../src/host/mcp/mcpOAuthConsent';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const SERVER_NAME = 'interaction-transport-fixture';

let responseHandler:
  | ((event: unknown, response: MCPElicitationResponse) => Promise<void>)
  | undefined;
let oauthResponseHandler:
  | ((event: unknown, response: { requestId: string; action: 'authorize' | 'decline' }) => Promise<void>)
  | undefined;
const clients: Client[] = [];
const servers: Server[] = [];

async function createElicitingTransport(): Promise<{ client: Client; registry: MCPToolRegistry }> {
  const client = new Client(
    { name: 'interaction-timeout-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION],
    },
  );
  const server = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION],
    },
  );
  clients.push(client);
  servers.push(server);

  registerElicitationHandler(client, SERVER_NAME);
  server.setRequestHandler('tools/call', async (request, context) => {
    if (request.params.name === 'stuck_tool') {
      return new Promise(() => {});
    }
    const elicitation = await context.mcpReq.elicitInput({
      mode: 'form',
      message: '请选择工作区',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
      },
    }, { timeout: INTERACTION_TIMEOUTS.PARKED_APPROVAL });

    return {
      content: [{ type: 'text', text: JSON.stringify(elicitation) }],
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, registry: new MCPToolRegistry() };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  platformMocks.getAllWindows.mockReturnValue([{ webContents: { send: platformMocks.send } }]);
  platformMocks.hasInteractiveUi.mockReturnValue(false);
  setBrowserWindowInteractionProbe(() => false);
  platformMocks.handle.mockImplementation((channel, handler) => {
    if (channel === IPC_CHANNELS.MCP_ELICITATION_RESPONSE) responseHandler = handler;
    if (channel === IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE) oauthResponseHandler = handler;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('MCP tool transport interaction timeout', () => {
  it('交互态挂过首次 60 秒与 retry 30 秒，应答后 tools/call 正常返回', async () => {
    platformMocks.hasInteractiveUi.mockReturnValue(true);
    setBrowserWindowInteractionProbe(() => true);
    const { client, registry } = await createElicitingTransport();
    vi.useFakeTimers();

    const result = registry.callExternalTool(
      'tool-interactive',
      SERVER_NAME,
      'wait_for_human',
      {},
      client,
    );
    await vi.waitFor(() => expect(platformMocks.send).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(91_000);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);

    const request = platformMocks.send.mock.calls[0]?.[1] as { id: string };
    await responseHandler?.({}, {
      requestId: request.id,
      action: 'accept',
      content: { workspace: '/tmp/project' },
    });

    await expect(result).resolves.toMatchObject({
      success: true,
      output: expect.stringContaining('/tmp/project'),
    });
  });

  it('无头态仍在 60 秒拒绝，MCP server 收到结构化原因', async () => {
    const { client, registry } = await createElicitingTransport();
    vi.useFakeTimers();

    const result = registry.callExternalTool(
      'tool-headless',
      SERVER_NAME,
      'wait_for_human',
      {},
      client,
    );
    await vi.waitFor(() => expect(platformMocks.send).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({
      success: true,
      output: expect.stringMatching(/permissionDecision.*deny.*permissionDecisionReason.*无头规则/),
    });
  });

  it('交互 UI 在线但没有 pending 人工输入时，挂死工具仍在 60 秒失败', async () => {
    platformMocks.hasInteractiveUi.mockReturnValue(true);
    setBrowserWindowInteractionProbe(() => true);
    const { client, registry } = await createElicitingTransport();
    vi.useFakeTimers();
    const result = registry.callExternalTool(
      'tool-stuck',
      SERVER_NAME,
      'stuck_tool',
      {},
      client,
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Request timed out',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
  });

  it('retry 路径有 pending elicitation 时不被 30 秒切断', async () => {
    platformMocks.hasInteractiveUi.mockReturnValue(true);
    setBrowserWindowInteractionProbe(() => true);
    const { client, registry } = await createElicitingTransport();
    vi.useFakeTimers();

    const result = registry.retryToolCall(
      'tool-retry',
      SERVER_NAME,
      'wait_for_human',
      {},
      client,
      Date.now(),
    );
    await vi.waitFor(() => expect(platformMocks.send).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(31_000);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);

    const request = platformMocks.send.mock.calls[0]?.[1] as { id: string };
    await responseHandler?.({}, {
      requestId: request.id,
      action: 'accept',
      content: { workspace: '/tmp/retry-project' },
    });
    await expect(result).resolves.toMatchObject({
      success: true,
      output: expect.stringContaining('/tmp/retry-project'),
    });
  });

  it('MCP OAuth consent 等人时也暂停同 server 的外圈短时限', async () => {
    platformMocks.hasInteractiveUi.mockReturnValue(true);
    setBrowserWindowInteractionProbe(() => true);
    vi.useFakeTimers();
    let completeTool: ((value: { content: { type: 'text'; text: string }[]; isError: false }) => void) | undefined;
    const client = {
      callTool: vi.fn((
        _request: unknown,
        options?: { signal?: AbortSignal },
      ) => new Promise<{ content: { type: 'text'; text: string }[]; isError: false }>((resolve, reject) => {
        completeTool = resolve;
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      })),
    };
    const registry = new MCPToolRegistry();
    const result = registry.callExternalTool(
      'tool-oauth',
      SERVER_NAME,
      'oauth_tool',
      {},
      client as never,
      { timeoutMs: 60_000 },
    );
    const consent = requestMcpOAuthConsent({
      serverName: SERVER_NAME,
      serverUrl: 'https://mcp.example.com',
      configSource: 'project',
      scope: 'read',
      authorizationServer: 'https://auth.example.com',
      redirectHost: '127.0.0.1:49152',
    });

    await vi.advanceTimersByTimeAsync(61_000);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);

    const request = platformMocks.send.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST,
    )?.[1] as { requestId: string };
    await oauthResponseHandler?.({}, { requestId: request.requestId, action: 'authorize' });
    await expect(consent).resolves.toMatchObject({ granted: true });
    completeTool?.({ content: [{ type: 'text', text: 'ok' }], isError: false });
    await expect(result).resolves.toMatchObject({ success: true, output: 'ok' });
  });
});
