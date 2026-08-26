import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { MCPElicitationResponse } from '../../../src/shared/contract';
import {
  hasInteractiveUi as realHasInteractiveUi,
  setBrowserWindowInteractionProbe,
} from '../../../src/host/platform/windowBridge';

const platformMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  getAllWindows: vi.fn(),
  hasInteractiveUi: vi.fn(),
}));
const notifyNeedsInputMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: platformMocks.handle },
  hasInteractiveUi: platformMocks.hasInteractiveUi,
  AppWindow: { getAllWindows: platformMocks.getAllWindows },
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: notifyNeedsInputMock },
}));

async function loadSubject() {
  vi.resetModules();
  let responseHandler: ((event: unknown, response: MCPElicitationResponse) => Promise<void>) | undefined;
  let requestHandler: ((request: {
    params: {
      mode: 'form';
      message: string;
      requestedSchema: { properties: Record<string, { type: 'string' }> };
    };
  }) => Promise<unknown>) | undefined;
  platformMocks.handle.mockImplementation((channel, handler) => {
    if (channel === IPC_CHANNELS.MCP_ELICITATION_RESPONSE) responseHandler = handler;
  });
  const client = {
    setRequestHandler: vi.fn((_method, handler) => { requestHandler = handler; }),
  };
  const subject = await import('../../../src/host/mcp/mcpElicitation');
  subject.registerElicitationHandler(client as never, 'Test MCP');
  return {
    getRequestHandler: () => requestHandler,
    getResponseHandler: () => responseHandler,
  };
}

const request = () => ({
  params: {
    mode: 'form' as const,
    message: '请选择工作区',
    requestedSchema: { properties: { workspace: { type: 'string' as const } } },
  },
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  platformMocks.getAllWindows.mockReturnValue([{ webContents: { send: platformMocks.send } }]);
  platformMocks.hasInteractiveUi.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
});

describe('MCP elicitation interaction policy', () => {
  it('有交互 UI 时挂过原 60 秒仍 pending，应答后成功', async () => {
    vi.useFakeTimers();
    setBrowserWindowInteractionProbe(() => true);
    platformMocks.hasInteractiveUi.mockImplementation(realHasInteractiveUi);
    const { getRequestHandler, getResponseHandler } = await loadSubject();
    const result = getRequestHandler()!(request());

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(notifyNeedsInputMock).toHaveBeenCalledTimes(1);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);
    const payload = platformMocks.send.mock.calls[0][1];
    await getResponseHandler()!({}, {
      requestId: payload.id,
      action: 'accept',
      content: { workspace: '/tmp/project' },
    });
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { workspace: '/tmp/project' },
    });
  });

  it('无交互 UI 时保留 60 秒超时并向 MCP 返回结构化拒绝', async () => {
    vi.useFakeTimers();
    const { getRequestHandler } = await loadSubject();
    const result = getRequestHandler()!(request());

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({
      action: 'cancel',
      content: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('无头规则'),
      },
    });
  });
});
