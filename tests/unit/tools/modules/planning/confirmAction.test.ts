// ============================================================================
// ConfirmAction (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const ipcMainHandleMock = vi.hoisted(() => vi.fn());
const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/host/platform', () => ({
  ipcHost: { handle: ipcMainHandleMock },
  AppWindow: { getAllWindows: getAllWindowsMock },
}));

import { confirmActionModule } from '../../../../../src/host/tools/modules/planning/confirmAction';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindowsMock.mockReturnValue([]);
  sendMock.mockReset();
});

describe('confirm_action schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(confirmActionModule.schema.name).toBe('confirm_action');
    expect(confirmActionModule.schema.category).toBe('planning');
    expect(confirmActionModule.schema.permissionLevel).toBe('execute');
    expect(confirmActionModule.schema.inputSchema.required).toEqual(['title', 'message']);
    const props = confirmActionModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.type.enum).toEqual(['danger', 'warning', 'info']);
  });
});

describe('confirm_action IPC protocol invariants', () => {
  it('CHANNEL constants 与 legacy 一致', () => {
    expect(IPC_CHANNELS.CONFIRM_ACTION_ASK).toBe('confirm-action:ask');
    expect(IPC_CHANNELS.CONFIRM_ACTION_RESPONSE).toBe('confirm-action:response');
  });

  it('webContents.send shape = {id, title, message, type, confirmText, cancelText, timestamp}', async () => {
    const window = { webContents: { send: sendMock } };
    getAllWindowsMock.mockReturnValue([window]);

    const handler = await confirmActionModule.createHandler();
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });
    const promise = handler.execute(
      { title: '删除文件', message: '确定？', type: 'danger', confirmText: '删除', cancelText: '取消' },
      ctx,
      allowAll,
    );
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    promise.catch(() => void 0);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendMock.mock.calls[0];
    expect(channel).toBe('confirm-action:ask');
    expect(channel).toBe(IPC_CHANNELS.CONFIRM_ACTION_ASK);
    expect(payload).toMatchObject({
      title: '删除文件',
      message: '确定？',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    expect(typeof payload.id).toBe('string');
    expect(payload.id).toMatch(/^confirm-\d+/);
    expect(typeof payload.timestamp).toBe('number');

    // ipcHost.handle once-guard
    const responseChannelCalls = ipcMainHandleMock.mock.calls.filter(
      (c) => c[0] === IPC_CHANNELS.CONFIRM_ACTION_RESPONSE,
    );
    expect(responseChannelCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('confirm_action validation', () => {
  it('缺 title → INVALID_ARGS', async () => {
    const handler = await confirmActionModule.createHandler();
    const result = await handler.execute({ message: 'm' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('缺 message → INVALID_ARGS', async () => {
    const handler = await confirmActionModule.createHandler();
    const result = await handler.execute({ title: 't' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await confirmActionModule.createHandler();
    const result = await handler.execute({ title: 't', message: 'm' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await confirmActionModule.createHandler();
    const result = await handler.execute(
      { title: 't', message: 'm' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('无 window → "cancelled (no UI available)"', async () => {
    getAllWindowsMock.mockReturnValue([]);
    const handler = await confirmActionModule.createHandler();
    const result = await handler.execute({ title: 't', message: 'm' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('cancelled (no UI available)');
  });
});
