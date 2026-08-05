import { describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';
import type { IpcMain } from '../../../src/host/platform';

describe('workspace openLinkInRail wiring', () => {
  it('dispatches the renderer request to the user-owned browser service', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const open = vi.fn(async () => ({
      conversationId: 'conversation-a',
      runId: 'user-run',
      surfaceSessionId: 'surface-user',
      snapshot: { version: 1 as const, conversationId: 'conversation-a', sessions: [], updatedAt: 1 },
    }));

    const end = vi.fn(async () => null);
    const history = vi.fn(async () => ({
      version: 1 as const,
      conversationId: 'conversation-a',
      sessions: [],
      updatedAt: 1,
    }));
    const dispatchUserInput = vi.fn(async () => ({
      version: 1 as const,
      conversationId: 'conversation-a',
      sessions: [],
      updatedAt: 1,
    }));
    registerWorkspaceHandlers(
      ipcMain,
      () => null,
      () => null,
      () => null,
      () => ({ open, end, history, dispatchUserInput }),
    );
    const handler = handlers.get(IPC_DOMAINS.WORKSPACE);
    expect(handler).toBeDefined();
    const request: IPCRequest = {
      action: 'openLinkInRail',
      payload: {
        conversationId: 'conversation-a',
        url: 'https://example.test/path',
        workspace: '/tmp/workspace',
      },
    };

    const response = await handler?.({}, request) as { success: boolean; data: unknown };
    expect(response.success).toBe(true);
    expect(open).toHaveBeenCalledWith(request.payload);

    const closeResponse = await handler?.({}, {
      action: 'closeLinkInRail',
      payload: { conversationId: 'conversation-a', reason: 'session-switch' },
    } satisfies IPCRequest) as { success: boolean };
    expect(closeResponse.success).toBe(true);
    expect(end).toHaveBeenCalledWith('conversation-a', 'session-switch');
  });

  // R2：dispatch/history 必须与 open 同口径兜底空 workspace；缺兜底时快速对话零透传。
  it('dispatchUserBrowserInput 在空 workspace 时仍调用 service（host 兜底）', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const open = vi.fn(async () => null);
    const end = vi.fn(async () => null);
    const history = vi.fn(async () => ({
      version: 1 as const,
      conversationId: 'conversation-a',
      sessions: [],
      updatedAt: 1,
    }));
    const dispatchUserInput = vi.fn(async () => ({
      version: 1 as const,
      conversationId: 'conversation-a',
      sessions: [],
      updatedAt: 1,
    }));
    registerWorkspaceHandlers(
      ipcMain,
      () => null,
      () => null,
      () => null,
      () => ({ open, end, history, dispatchUserInput }),
    );
    const handler = handlers.get(IPC_DOMAINS.WORKSPACE);
    const response = await handler?.({}, {
      action: 'dispatchUserBrowserInput',
      payload: {
        conversationId: 'conversation-a',
        workspace: '',
        input: { kind: 'click', x: 10, y: 20, button: 'left', clickCount: 1 },
      },
    } satisfies IPCRequest) as { success: boolean; error?: { message?: string } };
    expect(response.success).toBe(true);
    expect(dispatchUserInput).toHaveBeenCalledOnce();
    const arg = dispatchUserInput.mock.calls[0]![0] as {
      conversationId: string;
      workspace: string;
      input: unknown;
    };
    expect(arg.conversationId).toBe('conversation-a');
    // host 必须填入非空 workspace（会话目录或 dataDir/work 兜底），不能把空串原样传给 service
    expect(arg.workspace.trim().length).toBeGreaterThan(0);
    expect(arg.workspace.endsWith('work') || arg.workspace.includes('work')).toBe(true);

    const historyResponse = await handler?.({}, {
      action: 'controlUserBrowserHistory',
      payload: {
        conversationId: 'conversation-a',
        workspace: '',
        action: 'back',
      },
    } satisfies IPCRequest) as { success: boolean };
    expect(historyResponse.success).toBe(true);
    expect(history).toHaveBeenCalledOnce();
    const historyArg = history.mock.calls[0]![0] as { workspace: string; action: string };
    expect(historyArg.workspace.trim().length).toBeGreaterThan(0);
    expect(historyArg.action).toBe('back');
  });
});
